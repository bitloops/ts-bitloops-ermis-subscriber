export type SubscribeConfig = {
  applicationId: string;
  publicKey: string;
  server?: string;
};
export type ConnectionToken = string;
export type Unsubscribe = () => Promise<void>;

export type ListenerCallback = (event: MessageEvent<any>) => void;

export type UnsubscribeParams = {
  namedEvent: string;
  listenerCallback: ListenerCallback;
};
