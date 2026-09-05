import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';
import { enrichirLot, obtenirJwtFrais } from '../integrations/otareeSearchClient.js';

export const annoncesRouter = Router();

// TEMPORAIRE — essai GPT-5 nano à grande échelle, voir Ubiflow-Auto-API/index.js
// (/api/diag-test-gpt5-nano). À retirer une fois l'essai terminé.
annoncesRouter.get('/:id/diag-test-gpt5-nano', exigerConnexion, async (req, res) => {
    try {
        const row = await db.prepare(`SELECT raw_data FROM annonces WHERE id = ?`).get(req.params.id);
        if (!row) return res.status(404).json({ erreur: 'Annonce introuvable.' });
        const lotBrut = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
        const jeton = await obtenirJwtFrais();
        const lotEnrichi = await enrichirLot(lotBrut, jeton);
        const serverUrl = process.env.UBIFLOW_AUTO_API_URL || 'http://localhost:4000';
        const r = await fetch(`${serverUrl}/api/diag-test-gpt5-nano`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lot: lotEnrichi, modele: req.query.modele }),
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// TEMPORAIRE — sélection de l'échantillon pour l'essai GPT-5 nano à grande échelle : classe un
// lot de lots LMNP par catégorie de résidence + complétude des données, sans appel Otaree/OpenAI
// (lecture pure de raw_data déjà en base). À retirer une fois l'échantillon constitué.
annoncesRouter.get('/diag-classifier', exigerConnexion, async (req, res) => {
    try {
        const ids = (req.query.ids || '').split(',').map((s) => parseInt(s, 10)).filter(Boolean);
        if (!ids.length) return res.status(400).json({ erreur: 'ids requis' });
        const rows = await db
            .prepare(`SELECT id, titre, ville, raw_data FROM annonces WHERE id IN (${ids.map(() => '?').join(',')})`)
            .all(...ids);
        const resultat = rows.map((r) => {
            const raw = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
            return {
                id: r.id,
                titre: r.titre,
                ville: r.ville,
                residenceType: raw?.program?.residenceType || null,
                lawsKeys: raw?.lawsKeys || null,
                hasDescription: !!raw?.description,
                hasMonthlyRent: raw?.prices?.[0]?.monthlyRent != null,
                hasDeveloper: !!raw?.program?.developer,
            };
        });
        res.json(resultat);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Colonnes explicites, sans `images`/`raw_data`/`donnees_ia` — Supervision (le seul appelant,
// voir Supervision.jsx) n'affiche qu'un tableau de statuts, jamais les photos. `images` seule
// peut peser plusieurs Mo par annonce (jusqu'à 20 photos en base64) : avec LIMIT 200 et un
// rafraîchissement automatique toutes les 5s pendant que l'onglet est ouvert, un `SELECT *` ici
// pouvait retransmettre plusieurs centaines de Mo par minute — identifié comme responsable
// d'un dépassement réel du quota de transfert Neon.
const COLONNES_LISTE_ANNONCES = 'id, external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, scrapee_le, est_annonce_test';

annoncesRouter.get('/', exigerConnexion, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const annonces = q
            ? await db
                  .prepare(
                      `SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces
                       WHERE CAST(id AS TEXT) LIKE ? OR titre LIKE ? OR ville LIKE ?
                       ORDER BY scrapee_le DESC LIMIT 200`
                  )
                  .all(`%${q}%`, `%${q}%`, `%${q}%`)
            : await db.prepare(`SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces ORDER BY scrapee_le DESC LIMIT 200`).all();
        
        const getInstances = db.prepare(
            `SELECT ap.*, p.nom AS portail_nom
             FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
             WHERE ap.annonce_id = ?
             ORDER BY p.nom`
        );

        const result = [];
        for (const a of annonces) {
            result.push({
                ...a,
                portails: await getInstances.all(a.id),
            });
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.put('/:id', exigerConnexion, async (req, res) => {
    try {
        const { est_annonce_test } = req.body;
        if (est_annonce_test === undefined) {
            return res.status(400).json({ erreur: 'est_annonce_test requis' });
        }
        await db.prepare(`UPDATE annonces SET est_annonce_test = ? WHERE id = ?`).run(est_annonce_test ? 1 : 0, req.params.id);
        // Réponse jamais lue côté frontend (voir Supervision.jsx, onToggleTest) — pas la peine
        // de retransmettre images/raw_data pour une ligne dont le résultat est ignoré.
        res.json(await db.prepare(`SELECT ${COLONNES_LISTE_ANNONCES} FROM annonces WHERE id = ?`).get(req.params.id));
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.put('/:id/portails/:portailId', exigerConnexion, async (req, res) => {
    try {
        const { mode } = req.body;
        if (!['brouillon', 'actif'].includes(mode)) {
            return res.status(400).json({ erreur: "mode doit être 'brouillon' ou 'actif'" });
        }
        await db.prepare(
            `UPDATE annonce_portails SET mode = ?, maj_le = CURRENT_TIMESTAMP
             WHERE annonce_id = ? AND portail_id = ?`
        ).run(mode, req.params.id, req.params.portailId);
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/republish', exigerConnexion, async (req, res) => {
    try {
        await publierInstance(Number(req.params.id), Number(req.params.portailId));
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/depublier', exigerConnexion, async (req, res) => {
    try {
        const result = await depublierInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

annoncesRouter.post('/:id/portails/:portailId/synchroniser', exigerConnexion, async (req, res) => {
    try {
        const result = await synchroniserInstance(Number(req.params.id), Number(req.params.portailId));
        if (!result.success) {
            return res.status(502).json({ erreur: result.error });
        }
        res.json(
            await db
                .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
                .get(req.params.id, req.params.portailId)
        );
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});
