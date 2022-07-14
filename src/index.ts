import { Logger } from './logger';
import EventSource from 'eventsource';
import { v4 as uuid } from 'uuid';
import { Mutex } from 'async-mutex';
import { Unsubscribe, UnsubscribeParams, ListenerCallback } from './types';
import HTTP from './HTTP/http';
import { ConnectionToken } from './types';
import { AuthorizationError } from './HTTP/errors/AuthorizationError';
import { Result } from './shared/Result';
import { http } from './HTTP';
import { Config, ErmisOptions } from './config';

export default class ErmisClient {
  public static instance: ErmisClient;

  private http: HTTP;

  private config: Config;

  private subscribeConnection?: EventSource;

  private connectionId = '';

  private connectionToken?: string;

  private readonly eventMap = new Map();

  private reconnectFreqSecs = 1;

  private mutex: Mutex;

  private logger: Logger;

  private constructor(options: ErmisOptions) {
    this.config = new Config(options);
    this.http = http;
    this.mutex = new Mutex();
    this.logger = new Logger(options.debug ?? false);
  }

  public static getInstance(options: ErmisOptions) {
    if (!ErmisClient.instance) {
      ErmisClient.instance = new ErmisClient(options);
    }
    return ErmisClient.instance;
  }

  /**
   * @param namedEvent
   * @event Triggers callback when messages are pushed
   */
  public async subscribe<DataType>(
    namedEvent: string,
    callback: (data: DataType) => void,
  ): Promise<Unsubscribe> {
    // this.logger.log('subscribing topic:', namedEvent);
    this.eventMap.set(namedEvent, callback);
    const listenerCallback = this.prepareListenerCallback(namedEvent, callback);

    const release = await this.mutex.acquire();
    this.logger.log('I acquired the mutex', namedEvent);
    /** If you are the initiator, establish sse connection */
    this.logger.log('I  the mutex', namedEvent);
    if (!this.connectionEstablished()) {
      try {
        await this.setupEventSource();
      } catch (err) {
        this.logger.log('Error establishing sse connection', err);
        return this.unsubscribe({ namedEvent, listenerCallback });
      } finally {
        release();
        // this.logger.log('I released the mutex', namedEvent);
      }
    } else {
      release();
      this.logger.log('I released the mutex', namedEvent);
    }

    const result = await this.registerTopicORConnection(this.connectionId, namedEvent);
    if (result.isFailure) {
      throw result.getErrorValue();
    }

    this.logger.log(`add event listener for namedEvent: ${namedEvent}`);
    this.subscribeConnection?.addEventListener(namedEvent, listenerCallback);

    return this.unsubscribe({ namedEvent, listenerCallback });
  }

  private prepareListenerCallback<DataType>(
    namedEvent: string,
    callback: (data: DataType) => void,
  ): ListenerCallback {
    return (event: MessageEvent<any>) => {
      this.logger.log(`received event for namedEvent: ${namedEvent}`);
      callback(JSON.parse(event.data));
    };
  }

  private connectionEstablished() {
    return this.connectionId !== '';
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
    this.logger.log('registerTopicORConnection', subscriptionId, namedEvent);
    const { gwBaseUrl, subscribePath } = this.config;
    const subscribeUrl = `${gwBaseUrl}${subscribePath}/${subscriptionId}`;

    const headers = this.getAuthHeaders(this.connectionToken);
    // this.logger.log('Sending headers', headers);
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
      this.logger.log(`removed eventListener for ${namedEvent}`);
      this.eventMap.delete(namedEvent);
      if (this.eventMap.size === 0) {
        this.connectionId = '';
        this.subscribeConnection?.close();
      }

      const { gwBaseUrl, unsubscribePath } = this.config;
      const unsubscribeUrl = `${gwBaseUrl}${unsubscribePath}/${this.connectionId}`;

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

    const { gwBaseUrl, authorizePath } = this.config;
    const authUrl = `${gwBaseUrl}${authorizePath}`;
    const response = await this.http.handler({
      url: authUrl,
      method: 'POST',
      headers,
      data: {
        applicationId: this.config.applicationId,
        connectionId: this.connectionId,
      },
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
      this.logger.log('Trying to reconnect sse with', this.reconnectFreqSecs);
      this.reconnectFreqSecs = this.reconnectFreqSecs >= 60 ? 60 : this.reconnectFreqSecs * 2;
      return this.tryToResubscribe();
    }, this.reconnectFreqSecs * 1000);
  }

  private async tryToResubscribe() {
    this.logger.log('Attempting to resubscribe');
    // this.logger.log(' this.eventMap.length', this.eventMap.size);
    try {
      this.logger.log('Setting again eventsource');
      // Retrieve new token?
      await this.setupEventSource();
      const subscribePromises = Array.from(this.eventMap.entries()).map(([namedEvent, callback]) =>
        this.subscribe(namedEvent, callback),
      );
      await Promise.all(subscribePromises);
      this.logger.log('Resubscribed all topics successfully!');
    } catch (err) {
      return;
    }
  }

  private async setupEventSource() {
    this.connectionId = uuid();
    const authResult = await this.authorizeConnection();
    if (authResult.isFailure) {
      throw authResult.getErrorValue();
    }
    this.connectionToken = authResult.getValue();

    return new Promise<void>((resolve, reject) => {
      const { baseUrl, connectionPath } = this.config;
      const url = `${baseUrl}${connectionPath}`;

      // pass token from authResult.getValue();
      const headers: Record<string, string> = this.getAuthHeaders(this.connectionToken);
      const eventSourceInitDict = { headers };
      this.logger.log('headers', headers);

      this.subscribeConnection = new EventSource(url, eventSourceInitDict);
      this.subscribeConnection.onopen = () => {
        this.logger.log('The connection has been established.');
        this.reconnectFreqSecs = 1;
        return resolve();
      };

      this.subscribeConnection.onerror = (error: any) => {
        // on error, ermis will clear our connectionId so we need to create a new one
        this.logger.log('subscribeConnection.onerror, closing and re-trying', error);
        this.subscribeConnection?.close();
        this.sseReconnect();
        return reject(error);
      };
    });
  }

  private getAuthHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: 'Unauthorized ',
    };
    if (token) headers.Authorization = `User ${token}`;
    headers['public-key'] = this.config.publicKey;
    return headers;
  }
}
