/// <reference types="node" />
import debugConstructor from 'debug';
import fs from 'fs';
import puppeteer from 'puppeteer';
export declare const debug: debugConstructor.Debugger;
export declare function startLogging(text?: string): void;
export declare function stopLogging(text?: string, symbol?: string): void;
export declare function log(...obj: any): void;
export declare function logUpdate(...obj: string[]): void;
export declare function logSuccess(...obj: string[]): void;
export declare function logError(...obj: string[]): void;
export declare function logInfo(...obj: string[]): void;
export declare function gracefulError(err: Error): void;
export declare function readJSON(path: string): any;
export declare function statFile(filePath: string): Promise<fs.Stats>;
export declare function findAvailablePort(): Promise<number>;
export declare function findEntryPointFile(
  target: string,
  root: string,
): Promise<string>;
export declare function launchBrowser(
  options?: puppeteer.LaunchOptions,
): Promise<puppeteer.Browser>;
//# sourceMappingURL=util.d.ts.map
