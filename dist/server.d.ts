/// <reference types="node" />
import http from 'http';
import https from 'https';
export declare type LoadMode = 'document' | 'book';
export declare type PageSize =
  | {
      format: string;
    }
  | {
      width: string;
      height: string;
    };
declare type SourceServer = Server;
declare type BrokerServer = Server;
declare type NextFunction = (err?: any) => void;
declare type RequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: NextFunction,
) => void;
export interface Server {
  server: http.Server | https.Server;
  port: number;
}
export interface GetBrokerURLOption {
  sourcePort: number;
  sourceIndex: string;
  brokerPort: number;
  loadMode?: LoadMode;
  outputSize?: PageSize;
}
export declare function getBrokerUrl({
  sourcePort,
  sourceIndex,
  brokerPort,
  loadMode,
  outputSize,
}: GetBrokerURLOption): string;
export declare function startEndpoint({
  root,
  before,
}: {
  root: string;
  before?: RequestHandler[];
}): http.Server;
export declare function launchSourceAndBrokerServer(
  root: string,
): Promise<[SourceServer, BrokerServer]>;
export declare function launchBrokerServer(): Promise<BrokerServer>;
export declare function launchSourceServer(root: string): Promise<SourceServer>;
export {};
//# sourceMappingURL=server.d.ts.map
