import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stepTypeSchema } from '@smallseedlabs/proba-protocol';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs');

describe('walkthrough docs cover every step type', () => {
  const walkthroughs = readFileSync(join(docsDir, 'WALKTHROUGHS.md'), 'utf8');

  it.each(stepTypeSchema.options)('documents %s', (stepType) => {
    expect(walkthroughs).toMatch(new RegExp(`\`?${stepType}\`?`));
  });

  it('links the raise-budget deep dive', () => {
    expect(walkthroughs).toMatch(/WALKTHROUGH_RAISE_BUDGET\.md/);
    const raise = readFileSync(join(docsDir, 'WALKTHROUGH_RAISE_BUDGET.md'), 'utf8');
    expect(raise).toMatch(/propose_budget/);
    expect(raise).toMatch(/no_analytics_for_campaign/);
  });
});
