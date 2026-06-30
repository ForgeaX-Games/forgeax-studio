/**
 * forgeax-core — observability HOST 脱敏(S3 / N5 · 安全).
 *
 * 本仓有 env 泄漏前科(见 memory: old-studio-runtime-split-security):attr/field 里很容易混进
 * 整个 process.env、API key、token。redactor 是出墙前最后一道纵深防御。
 *
 * 两档 profile(A.5):
 *  - `wire`  —— 去浏览器/WS(可能离机),**更严**:更短截断、更宽的 deny 命中、整 env-bag 直接干掉。
 *  - `file`  —— host 端落盘,**较全**:截断更宽松,仍打码明显密钥。
 *
 * 另:**source-strict**(`redactStrictValueAtSource`)给 producer / setAttribute 包装在**写入时**
 * 就打码用 —— 因为 OTLP exporter 是 OTel 自己的、我们不在它出口插钩(A.5),strict 字段只能在源头脱敏
 * 才能让 OTLP 与落盘同时安全。boundary 档(这里的 redactProfile)是出口再过一道的纵深防御。
 *
 * 纯函数、无副作用、可独立单测(H5)。
 */

/** 脱敏档位。 */
export type RedactProfile = 'wire' | 'file';

/** 占位符:被打码的值统一替换成它(便于人/测试识别)。 */
export const REDACTED = '[REDACTED]';

/**
 * 字段名 deny-list(大小写不敏感、子串命中)。命中即整值打码,无视类型。
 * 覆盖密钥/令牌/口令/授权/cookie/私钥/连接串等最常见泄漏面。
 */
const DENY_KEY_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'auth',
  'credential',
  'cookie',
  'session_id',
  'sessionid',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'client_secret',
  'refresh_token',
  'bearer',
  'x-api-key',
  'anthropic_api_key',
  'openai_api_key',
];

/**
 * 整 env-bag 字段名(承载「把整个 process.env 塞进 attr」这类灾难)。
 * wire 档直接删掉,file 档逐键再过 deny。
 */
const ENV_BAG_KEYS = ['env', 'process.env', 'environment', 'envs'];

/** 值里的敏感模式(即便字段名干净也要打码,纵深防御)。 */
const VALUE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // Anthropic / OpenAI 形态的 key:sk-... / sk-ant-...
  { re: /sk-[a-zA-Z0-9_-]{16,}/g, why: 'sk-key' },
  // Bearer <token>
  { re: /Bearer\s+[A-Za-z0-9._-]{12,}/gi, why: 'bearer' },
  // 通用 JWT(三段 base64url)
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, why: 'jwt' },
  // AWS access key id
  { re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'aws-akid' },
  // 形如 key=value 的内联密钥(KEY/TOKEN/SECRET=xxxx)
  { re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s&;]{6,})/g, why: 'inline-kv' },
];

/** 各档的最大字符串值长度(超出截断,尾部加省略标记)。wire 更短防爆 WS/浏览器。 */
const MAX_VALUE_LEN: Record<RedactProfile, number> = {
  wire: 512,
  file: 4096,
};

function keyIsDenied(key: string): boolean {
  const k = key.toLowerCase();
  return DENY_KEY_SUBSTRINGS.some((d) => k.includes(d));
}

function keyIsEnvBag(key: string): boolean {
  const k = key.toLowerCase();
  return ENV_BAG_KEYS.includes(k);
}

/** 对单个字符串值做模式打码 + 截断。 */
function scrubString(value: string, profile: RedactProfile): string {
  let out = value;
  for (const { re } of VALUE_PATTERNS) {
    // 每个 pattern 用全局 re,reset lastIndex 防跨调用串状态。
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  const max = MAX_VALUE_LEN[profile];
  if (out.length > max) {
    out = `${out.slice(0, max)}…(+${out.length - max})`;
  }
  return out;
}

/** 递归脱敏任意值(对象/数组下钻)。depth 防御深嵌套/环。 */
function scrubValue(value: unknown, profile: RedactProfile, depth: number): unknown {
  if (depth > 6) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value, profile);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, profile, depth + 1));
  if (typeof value === 'object') {
    return redactBag(value as Record<string, unknown>, profile, depth + 1);
  }
  // function / symbol / bigint 等非线缆类型一律丢弃为占位
  return REDACTED;
}

/** 脱敏一个 bag(SpanData.attrs / LogRecord.fields 同形)。 */
function redactBag(
  bag: Record<string, unknown>,
  profile: RedactProfile,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (keyIsEnvBag(key)) {
      if (profile === 'wire') {
        // wire 档:整个 env-bag 不出墙。
        out[key] = REDACTED;
        continue;
      }
      // file 档:逐键再过 deny(保留非敏感 env 便于排错)。
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = redactBag(value as Record<string, unknown>, profile, depth + 1);
        continue;
      }
      out[key] = REDACTED;
      continue;
    }
    if (keyIsDenied(key)) {
      // deny-key 命中,但密钥/令牌必是**字符串**;数字/布尔不可能是密钥
      //   (与 scrubValue 对数字一律放行同源)。否则像 inputTokens/outputTokens/promptTokens
      //   这类「名字里含 token」的计数字段会被误打码,正当 token 用量反而看不见。
      if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
        continue;
      }
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(value, profile, depth + 1);
  }
  return out;
}

/**
 * 对一个 attr/field bag 按 profile 脱敏(boundary 档 · 出口纵深防御)。
 * 返回新对象,不改原 bag(纯函数)。
 */
export function redactBagWith(
  bag: Record<string, unknown> | undefined,
  profile: RedactProfile,
): Record<string, unknown> | undefined {
  if (!bag) return bag;
  return redactBag(bag, profile);
}

/**
 * source-strict:给 producer / setAttribute 包装在**写入时**打码用(A.5)。
 * 对单个值做最严档(wire)的模式打码 + 截断 —— 因为 OTLP 出口我们够不着,strict 字段
 * 只能在源头处理才能让 OTLP / 落盘同时安全。返回打码后的字符串值。
 *
 * 用法(producer 侧,Track C 域,不在本 track 改):
 *   span.setAttribute('http.authorization', redactStrictValueAtSource(rawHeader));
 */
export function redactStrictValueAtSource(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value, 'wire');
  return scrubValue(value, 'wire', 0);
}
