export function from(lines: Iterable<string>): string {
  return Array.from(lines).join('\n');
}

let indentCount = 0;

export type Lines =
  | string
  | Iterable<string>
  | (() => string | Iterable<string>);

export function* block(line: string, body: Lines): Iterable<string> {
  yield line;
  yield* indent(body);
  yield 'end';
}

export function* indent(lines: Lines): Iterable<string> {
  try {
    indentCount++;
    for (const line of iter(lines)) {
      yield line.trim().length
        ? `${'  '.repeat(indentCount)}${line.trim()}`
        : '';
    }
  } finally {
    indentCount--;
  }
}

function iter(lines: Lines) {
  function arr(value: string | Iterable<string>): Iterable<string> {
    return typeof value === 'string' ? [value] : value;
  }

  return typeof lines === 'function' ? arr(lines()) : arr(lines);
}

export function* comment(lines: Lines): Iterable<string> {
  for (const line of iter(lines)) {
    yield line.length ? `# ${line}` : '#';
  }
}
