import { ReplaceRule } from '@vivliostyle/vfm/lib/plugins/replace';
import fs from 'fs';
import shelljs from 'shelljs';
import path from 'upath';
import { processManuscriptHtml } from './html';
import { ManuscriptMediaType } from './input';
import { processMarkdown } from './markdown';
import { ParsedTheme, PreProcess } from './theme';

export type ParsedEntry = ManuscriptEntry | ContentsEntry;

export class Entry {
  title?: string;
  theme: ParsedTheme[];
  target: string;

  public constructor(
    title: string | undefined,
    theme: ParsedTheme[],
    target: string,
  ) {
    this.title = title;
    this.theme = theme;
    this.target = target;
  }

  public locateThemePath(from: string): string[] | undefined {
    if (this.theme.length == 0) return;
    let pathes: string[] = [];
    for (const t of this.theme) {
      pathes = pathes.concat(t.locateThemePath(from));
    }
    return pathes;
  }

  public importReplaceRules(): ReplaceRule[] {
    let replaceRules: ReplaceRule[] = [];
    if (this.theme) {
      for (const theme of this.theme) {
        replaceRules = theme.replace.concat(replaceRules);
      }
    }
    return replaceRules;
  }

  public importPreprocess(): PreProcess[] {
    let preprocess: PreProcess[] = [];
    if (this.theme) {
      for (const theme of this.theme) {
        if (theme.preprocess) {
          preprocess.unshift(theme.preprocess as PreProcess);
        }
      }
    }
    return preprocess;
  }

  //locateThemePath(path.dirname(entry.target), entry.theme);
  //locateThemePath(workspaceDir, generativeContentsEntry.theme);
}

export class ManuscriptEntry extends Entry {
  type: ManuscriptMediaType;
  source: string;
  rel?: string | string[];

  public constructor(
    type: ManuscriptMediaType,
    title: string | undefined,
    theme: ParsedTheme[],
    source: string,
    target: string,
    rel: string | string[] | undefined,
  ) {
    super(title, theme, target);
    this.type = type;
    this.source = source;
    this.rel = rel;
  }

  public getContents(
    filepath: string,
    preprocess: PreProcess[] | undefined,
  ): string {
    let contents = fs.readFileSync(filepath, 'utf8');
    if (contents && preprocess) {
      for (const proc of preprocess) {
        if (proc) {
          contents = proc(filepath, contents);
        }
      }
    }
    return contents;
  }

  /**
   *
   * @param language
   */
  public async copyContent(language: string | null) {
    shelljs.mkdir('-p', path.dirname(this.target));
    const style = this.locateThemePath(path.dirname(this.target));
    if (this.type === 'text/markdown') {
      const replaceRules = this.importReplaceRules();
      const preprocess = this.importPreprocess();
      const contents = this.getContents(this.source, preprocess);
      // compile markdown
      const vfile = await processMarkdown(
        { path: this.source, contents: contents },
        {
          style: style,
          title: this.title,
          language: language ?? undefined,
          replace: replaceRules,
        },
      );
      const compiledEntry = String(vfile);
      fs.writeFileSync(this.target, compiledEntry);
    } else if (
      this.type === 'text/html' ||
      this.type === 'application/xhtml+xml'
    ) {
      if (this.source !== this.target) {
        // TODO: getContents
        const html = processManuscriptHtml(this.source, {
          style: style,
          title: this.title,
          contentType: this.type,
          language,
        });
        fs.writeFileSync(this.target, html);
      }
    } else {
      if (this.source !== this.target) {
        shelljs.cp(this.source, this.target);
      }
    }
  }
}

export class ContentsEntry extends Entry {
  rel: 'contents' = 'contents';

  public constructor(title: string, theme: ParsedTheme[], target: string) {
    super(title, theme, target);
  }
}
