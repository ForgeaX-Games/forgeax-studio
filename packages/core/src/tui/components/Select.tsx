/** Select(T1)—— ↑↓ 移动高亮 + 回车确认 + 可选模糊过滤。
 *  对齐 Fallback.tsx 的交互范式(useInput 取 ↑↓/return);isActive 门控,避免与
 *  PromptInput 抢焦点——非激活时不挂 useInput。高亮行用 theme.accent + inverse。
 *  契约保留:SelectItem{label,value} + Select({items,onSelect})。新增可选 isActive/filter。
 *  Boundary(HOST 层):react + ink + 相对 import。 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../providers/theme';

export interface SelectItem {
  label: string;
  value: string;
}

export function Select(props: {
  items: SelectItem[];
  onSelect(v: string): void;
  /** 是否接管键盘(默认 true);false 时只展示、不挂 useInput,留给其它输入消费者。 */
  isActive?: boolean;
  /** 可选模糊过滤(对 label / value 大小写不敏感子串匹配)。 */
  filter?: string;
}): React.ReactElement {
  const theme = useTheme();
  const active = props.isActive ?? true;

  const filtered = useMemo<SelectItem[]>(() => {
    const f = (props.filter ?? '').trim().toLowerCase();
    if (!f) return props.items;
    return props.items.filter(
      (it) => it.label.toLowerCase().includes(f) || it.value.toLowerCase().includes(f),
    );
  }, [props.items, props.filter]);

  const [idx, setIdx] = useState(0);

  // 过滤后列表变短/变化 → 把高亮夹回有效范围。
  useEffect(() => {
    setIdx((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  // 仅激活时接管键盘(对齐 Fallback.tsx;non-active 不参与焦点竞争)。
  useInput(
    (_input, key) => {
      if (filtered.length === 0) return;
      if (key.upArrow) setIdx((i) => (i - 1 + filtered.length) % filtered.length);
      else if (key.downArrow) setIdx((i) => (i + 1) % filtered.length);
      else if (key.return) {
        const sel = filtered[idx];
        if (sel) props.onSelect(sel.value);
      }
    },
    { isActive: active },
  );

  if (filtered.length === 0) {
    return (
      <Box>
        <Text color={theme.dim}>{'  (无匹配项)'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {filtered.map((it, i) => {
        const on = i === idx && active;
        return (
          <Text key={it.value} color={on ? theme.accent : theme.text} inverse={on}>
            {on ? '> ' : '  '}
            {it.label}
          </Text>
        );
      })}
    </Box>
  );
}
