import { matchLanguage, resolveLanguage, ALLOWED_LANGUAGES } from '../../src/plugins/language';

describe('language matching', () => {
    it('reads the allowed languages from config/app.json', () => {
        expect(ALLOWED_LANGUAGES).toContain('de_DE');
    });

    it('matches exact codes in any separator/case, then by family', () => {
        expect(matchLanguage('de-DE')).toBe('de_DE');
        expect(matchLanguage('DE_de')).toBe('de_DE');
        expect(matchLanguage('de')).toBe('de_DE'); // 2-letter codes (e.g. a user.language column)
        expect(matchLanguage('de_AT')).toBe('de_DE');
    });

    it('rejects anything else', () => {
        expect(matchLanguage('xx')).toBeNull();
        expect(matchLanguage('')).toBeNull();
        expect(matchLanguage('a'.repeat(100))).toBeNull();
        expect(matchLanguage(undefined as any)).toBeNull();
    });

    it('resolves Accept-Language by quality, exact before family', () => {
        expect(resolveLanguage('fr-CA;q=0.9, de-DE;q=0.8')).toBe('de_DE'); // no exact fr_CA → exact de_DE wins
        expect(resolveLanguage('fr-CA')).toBe('fr_FR');
        expect(resolveLanguage('xx-YY')).toBe(resolveLanguage(''));
    });
});
