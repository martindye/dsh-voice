import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ui-primitives (and katex) ship `import '*.css'` inside their ESM dist;
    // Node cannot load that natively, so run those packages through vitest's
    // transform where CSS imports stub out cleanly.
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives', 'katex'],
      },
    },
  },
})
