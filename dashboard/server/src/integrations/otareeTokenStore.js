import { db } from '../db.js';

export async function sauvegarderRefreshToken(refreshToken, device, instanceId) {
    // Clear old tokens and save the new one
    await db.exec(`DELETE FROM otaree_tokens`);
    await db.prepare(`
        INSERT INTO otaree_tokens (refresh_token, device, instance_id)
        VALUES (?, ?, ?)
    `).run(refreshToken, device || null, instanceId || null);
}

export async function getOtareeTokenState() {
    try {
        const row = await db.prepare(`SELECT * FROM otaree_tokens ORDER BY id DESC LIMIT 1`).get();
        if (!row) {
            return { present: false, device: null, date: null };
        }
        return {
            present: !!row.refresh_token,
            device: row.device || null,
            date: row.cree_le || null,
        };
    } catch (e) {
        return { present: false, device: null, date: null };
    }
}

// Utilisé par otaree-search : tout ce qu'il faut pour rafraîchir un JWT et interroger l'API,
// en un seul appel — évite de relire/parser le fichier deux fois.
export async function getOtareeCredentials() {
    try {
        const row = await db.prepare(`SELECT * FROM otaree_tokens ORDER BY id DESC LIMIT 1`).get();
        if (!row || !row.refresh_token) return null;
        return {
            refreshToken: row.refresh_token,
            device: row.device || null,
            instanceId: row.instance_id || null,
        };
    } catch (e) {
        return null;
    }
}
