import { db } from '../db.js';
import { getEnAttente } from './autoPublishStatus.js';

const UBIFLOW_AUTO_API_URL = process.env.UBIFLOW_AUTO_API_URL || 'http://localhost:4000';

// Tolérance large volontaire : le prix Otaree peut légèrement bouger entre deux imports du même
// bien (remise, renégociation) — un vrai doublon ne doit pas passer sous le radar pour 5% d'écart.
const TOLERANCE_PRIX = 0.2;

async function rechercherPourVille(login, ville) {
    const url = `${UBIFLOW_AUTO_API_URL}/api/rechercher-doublons-hubiflow?espaceLoginAttendu=${encodeURIComponent(login)}&ville=${encodeURIComponent(ville)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || `échec (HTTP ${res.status})`);
    return data.annonces;
}

// Vérification à la demande (bouton explicite, jamais automatique — voir ScraperControl.jsx) :
// pour chaque lot sélectionné, cherche sur Hubiflow (portails réellement ciblés) des annonces déjà
// existantes dans la même ville et à un prix proche. Dégradation propre : un portail sans login,
// un token expiré, ou un appel Hubiflow en échec ne bloquent jamais rien — le lot concerné
// ressort simplement sans doublon signalé pour ce portail, jamais une erreur visible sur tout
// l'écran de confirmation.
export async function verifierDoublonsHubiflow(ids, portailsChoisis) {
    const attente = getEnAttente();
    if (!attente) return { erreur: 'Aucun run en attente de confirmation.' };

    const candidatsVises = attente.candidats.filter(({ annonce }) => ids.includes(annonce.id));
    if (!candidatsVises.length) return { resultats: {} };

    const portailIds = (portailsChoisis || []).map((p) => p.portailId).filter(Boolean);
    const portails = portailIds.length
        ? await db
              .prepare(`SELECT id, nom, login FROM portails WHERE id IN (${portailIds.map(() => '?').join(',')})`)
              .all(...portailIds)
        : [];
    const portailsAvecLogin = portails.filter((p) => p.login);

    // Cache par (login, ville) : plusieurs lots partagent souvent la même ville dans un même run,
    // pas la peine d'interroger Hubiflow deux fois pour la même combinaison.
    const cache = new Map();

    async function annoncesPourPortail(portail, ville) {
        const cle = `${portail.login}::${ville}`;
        if (cache.has(cle)) return cache.get(cle);
        const promesse = rechercherPourVille(portail.login, ville).catch((e) => {
            console.error(`[doublons] échec pour ${portail.login}/${ville} :`, e.message);
            return [];
        });
        cache.set(cle, promesse);
        return promesse;
    }

    const resultats = {};
    for (const { annonce } of candidatsVises) {
        if (!annonce.ville) continue;
        const prixLot = Number(annonce.prix);
        const trouvees = [];
        for (const portail of portailsAvecLogin) {
            const annoncesHubiflow = await annoncesPourPortail(portail, annonce.ville);
            for (const a of annoncesHubiflow) {
                if (!a.ville || a.ville.toLowerCase() !== annonce.ville.toLowerCase()) continue;
                if (prixLot && a.prix) {
                    const ecart = Math.abs(a.prix - prixLot) / prixLot;
                    if (ecart > TOLERANCE_PRIX) continue;
                }
                trouvees.push({ ...a, portailNom: portail.nom });
            }
        }
        if (trouvees.length) resultats[annonce.id] = trouvees;
    }
    return { resultats };
}
