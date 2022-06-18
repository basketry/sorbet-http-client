import {
  allHttpPaths,
  allParameters,
  File,
  Generator,
  HttpMethod,
  HttpParameter,
  HttpPath,
  Interface,
  isApiKeyScheme,
  isRequired,
  Literal,
  Method,
  Parameter,
  Service,
} from 'basketry';
import {
  buildInterfaceName,
  buildInterfaceNamespace,
  buildMethodName,
  buildParameterName,
  buildTypeName,
} from '@basketry/sorbet/lib/name-factory';

import { SorbetHttpClientOptions } from './types';
import { warning } from '@basketry/sorbet/lib/warning';
import { block, indent } from './utils';
import { pascal, snake } from 'case';
import {
  buildClientFilepath,
  buildMapperName,
  buildMapperNamespace,
} from './name-factory';

export const generateClients: Generator = (
  service,
  options?: SorbetHttpClientOptions,
) => {
  return new Builder(service, options).build();
};

const uri = 'safe_internal_uri';
const req = 'safe_internal_req';
const res = 'safe_internal_res';
const apiRoot = snake('apiRoot');

class Builder {
  constructor(
    private readonly service: Service,
    private readonly options?: SorbetHttpClientOptions,
  ) {}

  build(): File[] {
    const clientFiles = this.service.interfaces.map((int) =>
      this.buildClientFile(int),
    );

    return [...clientFiles];
  }

  private *comment(
    text: string | Literal<string> | Literal<string>[] | undefined,
  ): Iterable<string> {
    if (Array.isArray(text)) {
      for (const line of text) yield* this.comment(line);
    } else if (typeof text === 'string') {
      yield `# ${text}`;
    } else if (text) {
      yield `# ${text.value}`;
    }
  }

  private *magicComments(): Iterable<string> {
    if (this.options?.sorbet?.magicComments?.length) {
      for (const magicComment of this.options.sorbet.magicComments) {
        yield `# ${magicComment}`;
      }
      yield '';
    }
  }

  private buildClientFile(int: Interface): File {
    return {
      path: buildClientFilepath(int, this.service, this.options),
      contents: from(this.buildClient(int)),
    };
  }

  private *buildClient(int: Interface): Iterable<string> {
    const self = this;
    yield warning(this.service, require('../package.json'));
    yield '';

    yield* this.magicComments();

    yield '# typed: strict';
    yield '';

    if (this.options?.sorbet?.fileIncludes?.length) {
      for (const include of this.options.sorbet.fileIncludes) {
        yield `require '${include}'`;
      }
      yield '';
    }

    const methods = [...int.methods].sort((a, b) =>
      a.name.value.localeCompare(b.name.value),
    );

    yield* this.comment(int.description);
    yield* block(
      `module ${buildInterfaceNamespace(this.service, this.options)}`,
      block(`class ${pascal(int.name)}HttpClient`, function* () {
        yield 'extend T::Sig';
        yield '';
        yield `include ${buildInterfaceNamespace(
          self.service,
          self.options,
        )}::${buildInterfaceName(int)}`;
        yield `include ${buildMapperNamespace(
          self.service,
          self.options,
        )}::${buildMapperName()}`;
        yield '';
        yield* self.buildInitializer(int);
        for (const method of methods) {
          yield '';
          yield* self.comment(method.description);
          yield* self.buildSignature(method);
          yield* self.buildDefinition(method);
        }
      }),
    );

    yield '';
  }

  private *buildInitializer(int: Interface) {
    const names = Array.from(
      new Set(
        int.methods.flatMap((m) =>
          m.security.flatMap((s) => s).map((o) => snake(o.name.value)),
        ),
      ),
    );

    yield `sig { params(${apiRoot}: String${names.length ? `, ` : ''}${names
      .map((n) => `${n}: String`)
      .join(', ')}).void }`;
    yield* block(
      `def initialize(${apiRoot}:${names.length ? `, ` : ''}${names
        .map((n) => `${n}:`)
        .join(', ')})`,
      [`@${apiRoot} = ${apiRoot}`, ...names.map((n) => `@${n} = ${n}`)],
    );
  }

  private *buildSignature(method: Method): Iterable<string> {
    const self = this;

    if (method.returnType) {
      const typeName = buildTypeName({
        type: method.returnType!,
        service: this.service,
        options: this.options,
      });

      if (method.parameters.length) {
        yield* block('sig do', function* () {
          yield 'override.params(';
          yield* self.buildSignatureParameters(method);
          yield `).returns(`;
          yield* indent(typeName);
          yield `)`;
        });
      } else {
        yield `sig { override.returns(${typeName}) }`;
      }
    } else {
      if (method.parameters.length) {
        yield* block('sig do', function* () {
          yield 'override.params(';
          yield* self.buildSignatureParameters(method);
          yield ').void';
        });
      } else {
        yield 'sig { override.void }';
      }
    }
  }

  private *buildSignatureParameters(method: Method): Iterable<string> {
    yield* indent(
      sortParameters(method.parameters).map((param, i) => {
        const comma = i === method.parameters.length - 1 ? '' : ',';
        const typeName = buildTypeName({
          type: param,
          service: this.service,
          options: this.options,
        });
        const nilableTypeName = isRequired(param)
          ? typeName
          : `T.nilable(${typeName})`;

        return `${buildParameterName(param)}: ${nilableTypeName}${comma}`;
      }),
    );
  }

  private *buildDefinition(method: Method): Iterable<string> {
    const self = this;
    const [httpMethod, httpPath] =
      getHttp(this.service, method.name.value) || [];
    if (httpMethod && httpPath) {
      const parameters = method.parameters.length
        ? `(${sortParameters(method.parameters)
            .map(
              (param) =>
                `${buildParameterName(param)}:${
                  isRequired(param) ? '' : ' nil'
                }`,
            )
            .join(', ')})`
        : '';

      yield* block(`def ${buildMethodName(method)}${parameters}`, function* () {
        yield `${uri} = URI("${self.buildUri(httpPath, method)}")`;
        yield* self.buildQuery(method);
        yield `${req} = Net::HTTP::${pascal(httpMethod.verb.value)}.new(${uri})`;
        yield* self.buildHeaders(method);
        yield* self.buildBody(method);
        yield `${
          method.returnType ? `${res} = ` : ''
        }Net::HTTP.start(${uri}.hostname, ${uri}.port) { |http| http.request(${req}) }`;
        yield* self.buildReturn(method);
      });
    }
  }

  private buildUri(httpPath: HttpPath, method: Method): string {
    const map: Map<string, [Parameter, HttpParameter | undefined]> = new Map(
      method.parameters.map((p) => [
        p.name.value,
        [p, getHttpParameter(this.service, method.name.value, p.name.value)],
      ]),
    );

    function getParamName(seg: string): string | undefined {
      if (seg.startsWith(':')) {
        return seg.substring(1);
      } else if (seg.startsWith('{') && seg.endsWith('}')) {
        return seg.substring(1, seg.length - 1);
      }

      return undefined;
    }

    const subpath = httpPath.path.value
      .split('/')
      .map((seg) => {
        const paramName = getParamName(seg);
        if (!paramName) return seg;

        const [param, httpParam] = map.get(paramName) || [];
        if (!param || !httpParam || httpParam.in.value !== 'path') return seg;

        return `#{${buildParameterName(param)}}`; // TODO: cast to correct type
      })
      .join('/');

    return `#{@${apiRoot}}/v${this.service.majorVersion.value}${subpath}`;
  }

  private *buildQuery(method: Method): Iterable<string> {
    const paramsByName: Map<string, [Parameter, HttpParameter | undefined]> =
      new Map(
        method.parameters.map((p) => [
          p.name.value,
          [p, getHttpParameter(this.service, method.name.value, p.name.value)],
        ]),
      );

    const map = new Map<string, [Parameter, HttpParameter]>();

    for (const [name, [param, queryParam]] of paramsByName) {
      if (queryParam?.in?.value !== 'query') continue;
      map.set(name, [param, queryParam]);
    }

    // TODO: include API keys if present
    if (map.size) {
      yield `${uri}.query = URI.encode_www_form(`;
      yield* indent(function* () {
        yield '{';
        yield* indent(function* () {
          for (const [name, [param, queryParam]] of map) {
            yield `'${name}': ${buildParameterName(param)},`; // TODO: cast to correct type
          }
        });
        yield '}.compact';
      });

      yield ')';
    }
  }

  private *buildHeaders(method: Method): Iterable<string> {
    const paramsByName: Map<string, [Parameter, HttpParameter | undefined]> =
      new Map(
        method.parameters.map((p) => [
          p.name.value,
          [p, getHttpParameter(this.service, method.name.value, p.name.value)],
        ]),
      );

    const schemes = method.security.flatMap((s) => s);

    for (const scheme of schemes) {
      if (isApiKeyScheme(scheme) && scheme.in.value === 'header') {
        yield `${req}['${scheme.parameter.value}'] = @${snake(
          scheme.name.value,
        )}`;
      }
      // TODO: oauth tokens
    }

    for (const [name, [param, httpParam]] of paramsByName) {
      if (httpParam?.in?.value !== 'header') continue;
      yield `${req}['${httpParam.name.value}'] = ${buildParameterName(param)}`;
    }
  }

  private *buildBody(method: Method): Iterable<string> {
    const paramsByName: Map<string, [Parameter, HttpParameter | undefined]> =
      new Map(
        method.parameters.map((p) => [
          p.name.value,
          [p, getHttpParameter(this.service, method.name.value, p.name.value)],
        ]),
      );

    for (const [name, [param, httpParam]] of paramsByName) {
      if (httpParam?.in?.value !== 'body') continue;
      const paramName = buildParameterName(param);
      yield `${req}.body = map_${snake(
        param.typeName.value,
      )}_to_dto(${paramName}).to_s${
        isRequired(param) ? '' : ` if !${paramName}.nil?`
      }`;
    }
  }

  private *buildReturn(method: Method): Iterable<string> {
    if (method.returnType) {
      yield `map_dto_to_${snake(
        method.returnType.typeName.value,
      )}(JSON.parse(${res}.body))`;
    }
  }
}

function sortParameters(parameters: Parameter[]): Parameter[] {
  return [...parameters].sort(
    (a, b) => (isRequired(a) ? 0 : 1) - (isRequired(b) ? 0 : 1),
  );
}

function from(lines: Iterable<string>): string {
  return Array.from(lines).join('\n');
}

// TODO: move to basketry
const httpPathCache = new WeakMap<
  Service,
  Map<string, [HttpMethod, HttpPath]>
>();
function getHttp(
  service: Service,
  methodName: string,
): [HttpMethod, HttpPath] | undefined {
  if (!httpPathCache.has(service)) {
    const map = new Map<string, [HttpMethod, HttpPath]>();

    for (const { httpPath } of allHttpPaths(service, '', undefined)) {
      if (!httpPath) continue;
      for (const httpMethod of httpPath.methods) {
        map.set(snake(httpMethod.name.value), [httpMethod, httpPath]);
      }
    }
    httpPathCache.set(service, map);
  }

  return httpPathCache.get(service)!.get(snake(methodName));
}

// TODO: move to basketry
const httpParameterCache = new WeakMap<Service, Map<string, HttpParameter>>();
function getHttpParameter(
  service: Service,
  methodName: string,
  parameterName: string,
): HttpParameter | undefined {
  const key = (m: string, p: string): string => `${snake(m)}|||${snake(p)}`;

  if (!httpParameterCache.has(service)) {
    const map = new Map<string, HttpParameter>();

    for (const { method, httpParameter } of allParameters(
      service,
      '',
      undefined,
    )) {
      if (!httpParameter) continue;
      map.set(key(method.name.value, httpParameter.name.value), httpParameter);
    }
    httpParameterCache.set(service, map);
  }

  return httpParameterCache.get(service)!.get(key(methodName, parameterName));
}
