import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { AxiosHandlerOutcome } from './definitions';
import CanceledRequestError from './errors/CanceledRequestError';
import { CANCEL_REQUEST_MSG } from './errors/definitions';
import NetworkRestError from './errors/NetworkRestError';

type InterceptRequest = (config: AxiosRequestConfig<any>) => Promise<any>;
/*
 * If business login interceptor returns true,
 * we retry the request, if it returns false,
 * we rejectPromise the initial error
 */
type InterceptResponseError = (error: any) => Promise<boolean>;

/** Plain http post and get requests
 * They can be either intercepted or not
 */
export default class HTTP {
  public async handler(config: AxiosRequestConfig): Promise<AxiosHandlerOutcome> {
    try {
      const response = await axios(config);
      return { data: response, error: null };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        return { data: null, error: this.handleAxiosError(error) };
      }
      return { data: null, error };
    }
  }

  private handleAxiosError(error: AxiosError) {
    if (!error.response) {
      // Handle canceled requests from axios interceptors
      if (error.message === CANCEL_REQUEST_MSG) return new CanceledRequestError(error.message);
      // console.error('AxiosError', error.message, ':AND:', error);
      // network error - also !error.status
      return new NetworkRestError(error.message);
    }
    // http status code
    const code = error.response.status;
    // response data
    const response = error.response.data;
    return error.response;
  }
}
