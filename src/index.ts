import { generateClients } from './http-client-factory';
import { generateMapper } from './mapper-factory';

import { Generator } from 'basketry';

const generator: Generator = (service, options) => [
  ...generateClients(service, options),
  ...generateMapper(service, options),
];

export default generator;
