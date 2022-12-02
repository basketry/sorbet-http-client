import { Interface, Service } from 'basketry';
import { pascal, snake } from 'case';

import { buildNamespace } from '@basketry/sorbet/lib/name-factory';
import { SorbetHttpClientOptions } from './types';
import { sep } from 'path';

export function buildClientName(int: Interface): string {
  return pascal(`${int.name}_http_client`);
}
export function buildClientNamespace(
  service: Service,
  options?: SorbetHttpClientOptions,
): string {
  return buildNamespace(options?.sorbet?.interfacesModule, service, options);
}
export function buildClientFilepath(
  int: Interface,
  service: Service,
  options?: SorbetHttpClientOptions,
): string[] {
  const namespace = buildClientNamespace(service, options);

  return [
    ...namespace.split('::').map(snake),
    `${snake(buildClientName(int))}.rb`,
  ];
}

export function buildMapperName(): string {
  return pascal(`HttpClientHelpers`);
}
export function buildMapperNamespace(
  service: Service,
  options?: SorbetHttpClientOptions,
): string {
  return buildNamespace(undefined, service, options);
}
export function buildMapperFilepath(
  service: Service,
  options?: SorbetHttpClientOptions,
): string[] {
  const namespace = buildMapperNamespace(service, options);

  return [
    ...namespace.split('::').map(snake),
    `${snake(buildMapperName())}.rb`,
  ];
}
