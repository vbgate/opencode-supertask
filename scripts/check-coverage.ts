import { readFileSync } from 'fs';

const thresholds = {
    lines: 70,
    functions: 65,
};

const totals = {
    lines: { found: 0, hit: 0 },
    functions: { found: 0, hit: 0 },
};

for (const line of readFileSync('coverage/lcov.info', 'utf8').split('\n')) {
    const [key, rawValue] = line.split(':', 2);
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    if (key === 'LF') totals.lines.found += value;
    else if (key === 'LH') totals.lines.hit += value;
    else if (key === 'FNF') totals.functions.found += value;
    else if (key === 'FNH') totals.functions.hit += value;
}

let failed = false;
for (const key of Object.keys(thresholds) as Array<keyof typeof thresholds>) {
    const total = totals[key];
    if (total.found === 0) throw new Error(`Coverage report contains no ${key}`);
    const percent = total.hit / total.found * 100;
    console.log(`${key}: ${percent.toFixed(2)}% (${total.hit}/${total.found}), required ${thresholds[key]}%`);
    if (percent < thresholds[key]) failed = true;
}

if (failed) throw new Error('Coverage threshold not met');
