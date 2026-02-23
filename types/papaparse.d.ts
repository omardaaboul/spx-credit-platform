declare module "papaparse" {
  export type ParseError = {
    type: string;
    code: string;
    message: string;
    row?: number;
  };

  export type ParseMeta = {
    fields?: string[];
    delimiter?: string;
    linebreak?: string;
    aborted?: boolean;
    truncated?: boolean;
    cursor?: number;
  };

  export type ParseResult<T> = {
    data: T[];
    errors: ParseError[];
    meta: ParseMeta;
  };

  export type ParseConfig = {
    header?: boolean;
    skipEmptyLines?: boolean | "greedy";
  };

  type PapaStatic = {
    parse<T = unknown>(input: string, config?: ParseConfig): ParseResult<T>;
  };

  const Papa: PapaStatic;
  export default Papa;
}
