import { File, Generator, Service, Primitive, Type, Enum } from 'basketry';
import { snake } from 'case';

import { block, from, indent } from './utils';

import {
  buildNamespace,
  buildPropertyName,
  buildTypeName,
} from '@basketry/sorbet/lib/name-factory';
import { warning } from '@basketry/sorbet/lib/warning';
import { SorbetHttpClientOptions } from './types';
import { buildMapperFilepath, buildMapperName } from './name-factory';

export const generateMapper: Generator = (
  service,
  options?: SorbetHttpClientOptions,
) => {
  return new Builder(service, options).build();
};

class Builder {
  constructor(
    private readonly service: Service,
    private readonly options?: SorbetHttpClientOptions,
  ) {}

  private readonly castPrimitive = new Set<Primitive>();
  private readonly castPrimitiveArray = new Set<Primitive>();

  build(): File[] {
    return [this.buildMapperFile()];
  }

  private buildMapperFile(): File {
    return {
      path: buildMapperFilepath(this.service, this.options),
      contents: from(this.buildMapper()),
    };
  }

  private *buildMapper(): Iterable<string> {
    const self = this;
    yield warning(this.service, require('../package.json'));
    yield '';

    if (this.options?.sorbet?.magicComments?.length) {
      for (const magicComment of this.options.sorbet.magicComments) {
        yield `# ${magicComment}`;
      }
      yield '';
    }

    yield* block(
      `module ${buildNamespace(undefined, this.service, this.options)}`,

      block(`module ${buildMapperName()}`, function* () {
        let hasWritten = false;
        for (const type of self.service.types) {
          hasWritten ? yield '' : (hasWritten = true);
          const struct = self.buildFullyQualifiedTypeName(type);
          // DTO to struct
          yield `def map_dto_to_${snake(type.name.value)}(dto)`;
          yield* indent(function* () {
            yield `${struct}.new(`;
            yield* indent(
              type.properties.map((prop, i, arr) => {
                if (prop.isArray) {
                  return `${buildPropertyName(prop)}: dto['${
                    prop.name.value
                  }']&.map { |item| ${self.buildPropCast(
                    prop.typeName.value,
                    prop.isPrimitive,
                    `item`,
                  )} }${i < arr.length - 1 ? ',' : ''}`;
                } else {
                  return `${buildPropertyName(prop)}: ${self.buildPropCast(
                    prop.typeName.value,
                    prop.isPrimitive,
                    `dto['${prop.name.value}']`,
                  )}${i < arr.length - 1 ? ',' : ''}`;
                }
              }),
            );
            yield ')';
          });
          yield 'rescue StandardError';
          yield* indent('dto');
          yield 'end';

          // struct to DTO
          yield '';
          yield `def map_${snake(type.name.value)}_to_dto(${snake(
            type.name.value,
          )})`;
          yield* indent(function* () {
            yield `{`;
            yield* indent(
              type.properties.map((prop) => {
                if (prop.isArray) {
                  return `'${prop.name.value}': ${snake(
                    type.name.value,
                  )}.${buildPropertyName(
                    prop,
                  )}&.map { |item| ${self.buildDtoPropCast(
                    prop.typeName.value,
                    prop.isPrimitive,
                    `item`,
                  )} },`;
                } else {
                  return `'${prop.name.value}': ${self.buildDtoPropCast(
                    prop.typeName.value,
                    prop.isPrimitive,
                    `${snake(type.name.value)}.${buildPropertyName(prop)}`,
                  )},`;
                }
              }),
            );
            yield '}.compact';
          });
          yield 'rescue StandardError';
          yield* indent(snake(type.name.value));
          yield 'end';
        }
        for (const e of self.service.enums) {
          hasWritten ? yield '' : (hasWritten = true);
          // DTO to enum
          yield `def map_dto_to_${snake(e.name.value)}(dto)`;
          yield* indent(
            `${self.buildFullyQualifiedTypeName(e)}.deserialize(dto)`,
          );
          yield 'rescue StandardError';
          yield* indent('dto');
          yield 'end';
          // enum to DTO
          yield '';
          yield `def map_${snake(e.name.value)}_to_dto(enum)`;
          yield* indent(`enum&.serialize`);
          yield 'rescue StandardError';
          yield* indent('enum');
          yield 'end';
        }
        for (const primitive of self.castPrimitive) {
          hasWritten ? yield '' : (hasWritten = true);
          yield `def cast_${snake(primitive)}(param)`;
          yield* indent(
            `${self.buildPrimitiveCast(primitive, 'param')} if !param.nil?`,
          );
          yield 'rescue StandardError';
          yield* indent('param');
          yield 'end';
        }
        for (const primitive of self.castPrimitiveArray) {
          hasWritten ? yield '' : (hasWritten = true);
          yield `def cast_${snake(primitive)}_array(param)`;
          yield* indent(
            `param&.map { |item| ${self.buildPrimitiveCast(
              primitive,
              'item',
            )} if !item.nil? }`,
          );
          yield 'rescue StandardError';
          yield* indent('param');
          yield 'end';
        }
      }),
    );
    yield '';
  }

  private buildFullyQualifiedTypeName(type: Type | Enum) {
    return buildTypeName({
      type: {
        typeName: type.name,
        isPrimitive: false,
        isArray: false,
        rules: [],
      },
      service: this.service,
      options: this.options,
      skipArrayify: true,
    });
  }

  private buildPropCast(
    typeName: string,
    isPrimitive: boolean,
    baseCase: string,
  ): string {
    if (isPrimitive) {
      const override = this.options?.sorbet?.types?.[typeName];
      if (override) {
        return `${override}(${baseCase}.to_s)`;
      }

      const casted = this.buildPrimitiveCast(typeName as Primitive, baseCase);

      if (casted === baseCase) {
        return baseCase;
      } else {
        return `${baseCase}.is_a?(String) ? ${casted} : ${baseCase}`;
      }
    } else {
      return `map_dto_to_${snake(typeName)}(${baseCase})`;
    }
  }

  private buildDtoPropCast(
    typeName: string,
    isPrimitive: boolean,
    baseCase: string,
  ): string {
    if (isPrimitive) {
      switch (typeName as Primitive) {
        case 'date':
          return `${baseCase}&.to_s`;
        case 'date-time':
          return `${baseCase}&.utc&.iso8601`;
        default:
          return baseCase;
      }
    } else {
      return `map_${snake(typeName)}_to_dto(${baseCase})`;
    }
  }

  private buildPrimitiveCast(primitive: Primitive, baseCase: string): string {
    const override = this.options?.sorbet?.types?.[primitive];
    if (override) {
      return `${override}(${baseCase})`;
    }
    switch (primitive) {
      case 'boolean':
        return `ActiveModel::Type::Boolean.new.cast(${baseCase})`;
      case 'date':
        return `Date.parse(${baseCase})`;
      case 'date-time':
        return `DateTime.parse(${baseCase})`;
      case 'double':
      case 'float':
      case 'number':
        return `Float(${baseCase})`;
      case 'integer':
      case 'long':
        return `Integer(${baseCase}, 10)`;
      case 'null':
      case 'string':
      case 'untyped':
      default:
        return baseCase;
    }
  }
}
