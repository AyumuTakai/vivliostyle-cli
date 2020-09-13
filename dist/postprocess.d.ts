/// <reference types="node" />
import { Meta, TOCItem } from './broker';
export interface SaveOption {
  pressReady: boolean;
}
export declare class PostProcess {
  private document;
  static load(pdf: Buffer): Promise<PostProcess>;
  private constructor();
  save(output: string, { pressReady }: SaveOption): Promise<void>;
  metadata(tree: Meta): Promise<void>;
  toc(items: TOCItem[]): Promise<void>;
}
//# sourceMappingURL=postprocess.d.ts.map
