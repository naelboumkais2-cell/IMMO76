// Lit l'état réel du token Ubiflow actif, directement depuis Ubiflow-Auto-API/token.json —
// plutôt que de dupliquer "quel espace est actif" dans la base du dashboard, ce qui créerait
// deux sources de vérité pouvant diverger. Lecture seule, tolérante à l'absence/corruption du
// fichier (le dashboard doit rester utilisable même si l'autre serveur n'a jamais tourné).
//
// Depuis le multi-token (server.js stocke désormais { tokens: { [login]: {token, date} } }, un
// par espace), "l'espace actif" affiché ici garde le même sens qu'avant le multi-token : le
// dernier espace connecté (entrée la plus récente de la collection) — pas "n'importe lequel des
// espaces valides". Le badge "Actif"/l'avertissement de Supervision.jsx gardent donc leur sens
// actuel ; une vraie notion "plusieurs espaces utilisables en parallèle" est un sujet à part,
// pas couvert ici.
//
// Couplage volontaire et temporaire par chemin de fichier partagé : dashboard/ et
// Ubiflow-Auto-API/ tournent sur la même machine, dans le même repo. À revoir (vraie API ou
// événement) si les deux services sont un jour déployés séparément.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', '..', '..', '..', 'Ubiflow-Auto-API', 'token.json');

export function getEspaceActif() {
    try {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));

        if (data.tokens) {
            const plusRecent = Object.entries(data.tokens).sort(
                (a, b) => new Date(b[1].date) - new Date(a[1].date)
            )[0];
            if (!plusRecent) return { espaceLogin: null, tokenPresent: false };
            return { espaceLogin: plusRecent[0], tokenPresent: !!plusRecent[1].token };
        }

        // Ancien format à plat — encore lisible tant que Ubiflow-Auto-API/server.js n'a pas
        // tourné au moins une fois pour migrer le fichier.
        return { espaceLogin: data.espaceLogin || null, tokenPresent: !!data.token };
    } catch (e) {
        return { espaceLogin: null, tokenPresent: false };
    }
}
