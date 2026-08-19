/**
 * @retorquere/bibtex-parser@10 ships no .d.ts (package.json "types" points at a
 * missing dist/types/). Minimal declaration of the surface we use, verified
 * against dist/esm/index.js output.
 */
declare module '@retorquere/bibtex-parser' {
  export interface Creator {
    lastName?: string;
    firstName?: string;
    prefix?: string;
    suffix?: string;
    name?: string;
  }

  /** Field values: creator lists, literal lists, or resolved literal strings. */
  export type FieldValue = string | string[] | Creator[];

  export interface Entry {
    type: string;
    key: string;
    fields: Record<string, FieldValue>;
    mode: Record<string, string>;
    /** Raw source text of this entry. */
    input: string;
    /** Present when crossref-parent fields were inherited. */
    crossref?: Record<string, Record<string, string>>;
  }

  export interface ParseError {
    error: string;
    input: string;
  }

  export interface Bibliography {
    errors: ParseError[];
    entries: Entry[];
    comments: string[];
    strings: Record<string, string>;
    preamble: string[];
  }

  export interface ParseOptions {
    /** false disables sentence-casing and English-specific restyling. */
    sentenceCase?: false | { preserveQuoted?: boolean; subSentence?: boolean; guess?: boolean };
    english?: boolean | string[];
    caseProtection?: boolean | 'as-needed' | 'strict';
  }

  export function parse(input: string, options?: ParseOptions): Bibliography;
}
