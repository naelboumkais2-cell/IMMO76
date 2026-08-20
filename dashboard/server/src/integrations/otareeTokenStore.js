// Stocke le refresh_token Otaree capturé par extension-chrome/Otaree/ (voir inject.js) —
// fichier séparé, gitignored, jamais loggé en clair. Même principe que
// Ubiflow-Auto-API/token.json, mais un mécanisme de capture entièrement indépendant : une
// extension différente (Otaree, pas Ubiflow-API-Companion), une destination différente (ce
// serveur, port 4100, pas Ubiflow-Auto-API port 4000).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', '..', 'data', 'otaree-token.json');

export function sauvegarderRefreshToken(refreshToken, device, instanceId) {
    fs.writeFileSync(
        TOKEN_FILE,
        JSON.stringify({ refreshToken, device, instanceId, date: new Date().toISOString() }, null, 2)
    );
}

export function getOtareeTokenState() {
    try {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        return {
            present: !!data.refreshToken,
            device: data.device || null,
            date: data.date || null,
        };
    } catch (e) {
        return { present: false, device: null, date: null };
    }
}

// Utilisé par otaree-search : tout ce qu'il faut pour rafraîchir un JWT et interroger l'API,
// en un seul appel — évite de relire/parser le fichier deux fois.
export function getOtareeCredentials() {
    try {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (!data.refreshToken) return null;
        return {
            refreshToken: data.refreshToken,
            device: data.device || null,
            instanceId: data.instanceId || null,
        };
    } catch (e) {
        return null;
    }
}
