export type CliLocale = 'zh-CN' | 'en';

function requestedLanguage(argv: string[]): string | undefined {
    for (let index = 2; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--lang') return argv[index + 1];
        if (argument.startsWith('--lang=')) return argument.slice('--lang='.length);
    }
    return undefined;
}

export function resolveCliLocale(
    argv: string[] = process.argv,
    env: NodeJS.ProcessEnv = process.env,
): CliLocale {
    const requested = requestedLanguage(argv) ?? env.SUPERTASK_LANG ?? 'auto';
    if (requested === 'zh' || requested === 'zh-CN') return 'zh-CN';
    if (requested === 'en') return 'en';

    const systemLocale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
    return /^zh(?:[_-]|$)/i.test(systemLocale) ? 'zh-CN' : 'en';
}

export function cliText(locale: CliLocale, zh: string, en: string): string {
    return locale === 'zh-CN' ? zh : en;
}
