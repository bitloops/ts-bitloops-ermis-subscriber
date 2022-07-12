import EventSource from 'eventsource';
import { v4 as uuid } from 'uuid';
import { Unsubscribe, UnsubscribeParams, ListenerCallback } from './definitions';
import HTTP from './HTTP';
import NetworkRestError from './HTTP/errors/NetworkRestError';
import { Mutex } from 'async-mutex';
import { SubscribeConfig } from './types';
import { SERVICE_BASE_URL } from './constants';

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
    // console.log('subscribing topic:', namedEvent);
    this.eventMap.set(namedEvent, callback);
    const listenerCallback = this.modifyListenerCallback(namedEvent, callback);

    const release = await this.mutex.acquire();
    console.log('I acquired the mutex', namedEvent);
    /** If you are the initiator, establish sse connection */
    if (!this.connectionEstablished()) {
      try {
        await this.setupEventSource();
      } catch (err) {
        return this.unsubscribe({ namedEvent, listenerCallback });
      } finally {
        release();
        console.log('I released the mutex', namedEvent);
      }
    } else {
      release();
      console.log('I released the mutex', namedEvent);
    }

    try {
      await this.registerTopicORConnection(this.subscriptionId, namedEvent);
    } catch (error) {
      if (error instanceof NetworkRestError)
        console.error(`Got error response from REST: ${error}`);
      // TODO improve this
      return async () => {
        // pass
      };
    }

    console.log(`add event listener for namedEvent: ${namedEvent}`);
    this.subscribeConnection?.addEventListener(namedEvent, listenerCallback);

    return this.unsubscribe({ namedEvent, listenerCallback });
  }

  private modifyListenerCallback<DataType>(
    namedEvent: string,
    callback: (data: DataType) => void,
  ): ListenerCallback {
    return (event: MessageEvent<any>) => {
      console.log(`received event for namedEvent: ${namedEvent}`);
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
  private async registerTopicORConnection(subscriptionId: string, namedEvent: string) {
    const subscribeUrl = `${this.baseUrl}/bitloops/events/subscribe/${subscriptionId}`;

    const headers = this.getAuthHeaders();
    // console.log('Sending headers', headers);
    return this.http.handler({
      url: subscribeUrl,
      method: 'POST',
      headers,
      data: { topic: namedEvent },
    });
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
      console.log(`removed eventListener for ${namedEvent}`);
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

  /**
   * Ask for new connection
   */
  private sseReconnect() {
    setTimeout(async () => {
      console.log('Trying to reconnect sse with', this.reconnectFreqSecs);
      this.reconnectFreqSecs = this.reconnectFreqSecs >= 60 ? 60 : this.reconnectFreqSecs * 2;
      return this.tryToResubscribe();
    }, this.reconnectFreqSecs * 1000);
  }

  private async tryToResubscribe() {
    console.log('Attempting to resubscribe');
    // console.log(' this.eventMap.length', this.eventMap.size);
    try {
      console.log('Setting again eventsource');
      await this.setupEventSource();
      const subscribePromises = Array.from(this.eventMap.entries()).map(([namedEvent, callback]) =>
        this.subscribe(namedEvent, callback),
      );
      await Promise.all(subscribePromises);
      console.log('Resubscribed all topics successfully!');
    } catch (err) {
      return;
    }
  }

  private async setupEventSource() {
    return new Promise<void>((resolve, reject) => {
      this.subscriptionId = uuid();
      const url = `${this.baseUrl}/bitloops/events/${this.subscriptionId}`;

      const headers = this.getAuthHeaders();
      const eventSourceInitDict = { headers };

      this.subscribeConnection = new EventSource(url, eventSourceInitDict);
      this.subscribeConnection.onopen = () => {
        console.log('The connection has been established.');
        this.reconnectFreqSecs = 1;
        return resolve();
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.subscribeConnection.onerror = (error: any) => {
        // on error, ermis will clear our connectionId so we need to create a new one
        console.log('subscribeConnection.onerror, closing and re-trying', error);
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
