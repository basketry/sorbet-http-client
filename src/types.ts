import { SorbetOptions } from '@basketry/sorbet/lib/types';

export type SorbetHttpClientOptions = {
  sorbet?: SorbetOptions & {
    lib?: string;
  };
};
