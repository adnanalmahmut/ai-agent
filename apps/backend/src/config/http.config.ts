import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'staging', 'production'])
    .default('development'),
});

export default registerAs('http', () => {
  const env = schema.parse(process.env);
  const reverseProxyEnvironment =
    env.NODE_ENV === 'staging' || env.NODE_ENV === 'production';

  return {
    /**
     * Numeric by design. `true` trusts an attacker-controlled chain of
     * arbitrary length; one trusts only the socket peer and uses the single
     * value that host Nginx overwrote immediately before forwarding.
     */
    trustProxyHops: reverseProxyEnvironment ? 1 : 0,
    overwriteDirectIpHeaders: !reverseProxyEnvironment,
  };
});
