export type ErmisOptions = {
  applicationId: string;
  publicKey: string;
  host?: string;
  gwHost?: string;
  ssl?: boolean;
};

export class Config {
  private _applicationId: string;
  // add remaining private members from constructor body
  private _publicKey: string;
  private _host: string;
  private _gwHost: string;
  private _ssl: boolean;
  private _subscribePath: string;
  private _unsubscribePath: string;
  private _connectionPath: string;
  private _authorizePath: string;

  constructor(options: ErmisOptions) {
    this._applicationId = options.applicationId;
    this._publicKey = options.publicKey;
    this._host = options.host ?? 'api.ermis.io';
    this._gwHost = options.gwHost ?? 'gw.ermis.io';
    this._ssl = options.ssl || false;
    this._subscribePath = '/bitloops/events/subscribe';
    this._unsubscribePath = '/bitloops/events/unsubscribe';
    this._connectionPath = '/bitloops/events';
    this._authorizePath = '/bitloops/events/authorize';
  }

  getConfig(): ErmisOptions {
    return {
      applicationId: this._applicationId,
      publicKey: this._publicKey,
      host: this._host,
      ssl: this._ssl,
    };
  }

  get applicationId(): string {
    return this._applicationId;
  }

  get publicKey(): string {
    return this._publicKey;
  }

  get host(): string {
    return this._host;
  }

  get gwHost(): string {
    return this._gwHost;
  }

  get ssl(): boolean {
    return this._ssl;
  }

  get subscribePath(): string {
    return this._subscribePath;
  }

  get unsubscribePath(): string {
    return this._unsubscribePath;
  }

  get connectionPath(): string {
    return this._connectionPath;
  }

  get authorizePath(): string {
    return this._authorizePath;
  }

  get baseUrl(): string {
    return `${this.ssl ? 'https' : 'http'}://${this.host}`;
  }

  get gwBaseUrl(): string {
    return `${this.ssl ? 'https' : 'http'}://${this.gwHost}`;
  }
}
