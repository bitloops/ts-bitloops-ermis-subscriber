import EventSource from 'eventsource';
import { v4 as uuid } from 'uuid';
import { Mutex } from 'async-mutex';
import { Unsubscribe, UnsubscribeParams, ListenerCallback } from './types';
import HTTP from './HTTP';
import { ConnectionToken, SubscribeConfig } from './types';
import { SERVICE_BASE_URL } from './constants';
import { AuthorizationError } from './HTTP/errors/AuthorizationError';
import { Result } from './shared/Result';

export default class ServerSentEvents {
  public static instance: ServerSentEvents;

  private http: HTTP;

  private config: SubscribeConfig;

  private subscribeConnection?: EventSource;

  private subscriptionId = '';

  private readonly eventMap = new Map();

  private reconnectFreqSecs = 1;

  private mutex: Mutex;

  private baseUrl: string;

  private constructor(http: HTTP, config: SubscribeConfig) {
    this.http = http;
    this.config = config;
    this.mutex = new Mutex();
    this.baseUrl = config.server ?? SERVICE_BASE_URL;
  }

  public static getInstance(http: HTTP, config: SubscribeConfig) {
    if (!ServerSentEvents.instance) {
      ServerSentEvents.instance = new ServerSentEvents(http, config);
    }
    return ServerSentEvents.instance;
  }

  /**
   * @param namedEvent
   * @event Triggers callback when messages are pushed
   */
  public async subscribe<DataType>(
    namedEvent: string,
    callback: (data: DataType) => void,
  ): Promise<Unsubscribe> {
    // console.debug('subscribing topic:', namedEvent);
    this.eventMap.set(namedEvent, callback);
    const listenerCallback = this.prepareListenerCallback(namedEvent, callback);

    const release = await this.mutex.acquire();
    console.debug('I acquired the mutex', namedEvent);
    /** If you are the initiator, establish sse connection */
    if (!this.connectionEstablished()) {
      try {
        await this.setupEventSource();
      } catch (err) {
        return this.unsubscribe({ namedEvent, listenerCallback });
      } finally {
        release();
        // console.debug('I released the mutex', namedEvent);
      }
    } else {
      release();
      //   console.debug('I released the mutex', namedEvent);
    }

    const result = await this.registerTopicORConnection(this.subscriptionId, namedEvent);
    if (result.isFailure) {
      throw result.getErrorValue();
    }

    console.debug(`add event listener for namedEvent: ${namedEvent}`);
    this.subscribeConnection?.addEventListener(namedEvent, listenerCallback);

    return this.unsubscribe({ namedEvent, listenerCallback });
  }

  private prepareListenerCallback<DataType>(
    namedEvent: string,
    callback: (data: DataType) => void,
  ): ListenerCallback {
    return (event: MessageEvent<any>) => {
      console.debug(`received event for namedEvent: ${namedEvent}`);
      callback(JSON.parse(event.data));
    };
  }

  private connectionEstablished() {
    return this.subscriptionId !== '';
  }

  /**
   * Gets a new connection Id if called from the first subscriber
   * In all cases it registers the topic to the Connection Id
   * @param subscriptionId
   * @param namedEvent
   * @returns
   */
  private async registerTopicORConnection(
    subscriptionId: string,
    namedEvent: string,
  ): Promise<Result<void>> {
    const subscribeUrl = `${this.baseUrl}/bitloops/events/subscribe/${subscriptionId}`;

    const headers = this.getAuthHeaders();
    // console.debug('Sending headers', headers);
    try {
      await this.http.handler({
        url: subscribeUrl,
        method: 'POST',
        headers,
        data: { topic: namedEvent },
      });
      return Result.ok();
    } catch (error: any) {
      //   if (error instanceof NetworkRestError)
      //     console.error(`Got error response from REST: ${error}`);
      return Result.fail(error.message);
    }
  }

  /**
   * Removes event listener from subscription.
   * Deletes events from mapping that had been subscribed.
   * Handles remaining dead subscription connections, in order to not send events.
   * @param subscriptionId
   * @param namedEvent
   * @param listenerCallback
   * @returns void
   */
  private unsubscribe({ namedEvent, listenerCallback }: UnsubscribeParams) {
    return async (): Promise<void> => {
      this.subscribeConnection?.removeEventListener(namedEvent, listenerCallback);
      console.debug(`removed eventListener for ${namedEvent}`);
      this.eventMap.delete(namedEvent);
      if (this.eventMap.size === 0) {
        this.subscriptionId = '';
        this.subscribeConnection?.close();
      }

      const unsubscribeUrl = `${this.baseUrl}/bitloops/events/unsubscribe/${this.subscriptionId}`;

      const headers = this.getAuthHeaders();

      await this.http.handler({
        url: unsubscribeUrl,
        method: 'POST',
        headers,
        data: { topic: namedEvent },
      });
    };
  }

  private async authorizeConnection(): Promise<Result<ConnectionToken>> {
    const headers = this.getAuthHeaders();
    const authUrl = `${this.baseUrl}/bitloops/events/authorize`;
    const response = await this.http.handler({
      url: authUrl,
      method: 'POST',
      headers,
      data: {},
    });
    const { data, error } = response;
    if (error || !data) {
      if (error instanceof AuthorizationError) {
        return Result.fail(error.message);
      }
      return Result.fail('Unexpected error' + error);
    }

    const { token } = data.data as any;
    return Result.ok(token);
  }

  /**
   * Ask for new connection
   */
  private sseReconnect() {
    setTimeout(async () => {
      console.debug('Trying to reconnect sse with', this.reconnectFreqSecs);
      this.reconnectFreqSecs = this.reconnectFreqSecs >= 60 ? 60 : this.reconnectFreqSecs * 2;
      return this.tryToResubscribe();
    }, this.reconnectFreqSecs * 1000);
  }

  private async tryToResubscribe() {
    console.debug('Attempting to resubscribe');
    // console.debug(' this.eventMap.length', this.eventMap.size);
    try {
      console.debug('Setting again eventsource');
      // Retrieve new token?
      await this.setupEventSource();
      const subscribePromises = Array.from(this.eventMap.entries()).map(([namedEvent, callback]) =>
        this.subscribe(namedEvent, callback),
      );
      await Promise.all(subscribePromises);
      console.debug('Resubscribed all topics successfully!');
    } catch (err) {
      return;
    }
  }

  private async setupEventSource() {
    this.subscriptionId = uuid();
    const authResult = await this.authorizeConnection();
    if (authResult.isFailure) {
      throw authResult.getErrorValue();
    }

    return new Promise<void>((resolve, reject) => {
      const url = `${this.baseUrl}/bitloops/events/${this.subscriptionId}`;

      const headers: Record<string, string> = this.getAuthHeaders();
      headers.token = authResult.getValue();
      const eventSourceInitDict = { headers };

      this.subscribeConnection = new EventSource(url, eventSourceInitDict);
      this.subscribeConnection.onopen = () => {
        console.debug('The connection has been established.');
        this.reconnectFreqSecs = 1;
        return resolve();
      };

      this.subscribeConnection.onerror = (error: any) => {
        // on error, ermis will clear our connectionId so we need to create a new one
        console.debug('subscribeConnection.onerror, closing and re-trying', error);
        this.subscribeConnection?.close();
        this.sseReconnect();
        return reject(error);
      };
    });
  }

  private getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Unauthorized ' };
    headers.Authorization = this.config.publicKey;
    return headers;
  }
}
