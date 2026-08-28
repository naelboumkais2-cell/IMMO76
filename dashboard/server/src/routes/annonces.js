import { Router } from 'express';
import { db } from '../db.js';
import { exigerConnexion } from '../middleware/auth.js';
import { publierInstance, depublierInstance, synchroniserInstance } from '../services/orchestrator.js';
import { parseFiltresOtareeDepuisUrl } from '../integrations/otareeSearchClient.js';

export const annoncesRouter = Router();

// Colonnes explicites, sans `images`/`raw_data`/`donnees_ia` — Supervision (le seul appelant,
// voir Supervision.jsx) n'affiche qu'un tableau de statuts, jamais les photos. `images` seule
// peut peser plusieurs Mo par annonce (jusqu'à 20 photos en base64) : avec LIMIT 200 et un
// rafraîchissement automatique toutes les 5s pendant que l'onglet est ouvert, un `SELECT *` ici
// pouvait retransmettre plusieurs centaines de Mo par minute — identifié comme responsable
// d'un dépassement réel du quota de transfert Neon.
const COLONNES_LISTE_ANNONCES = 'id, external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, scrapee_le, est_annonce_test';

// Diagnostic temporaire (à retirer une fois la génération de référence LMNP validée avec
// l'utilisateur) — sert à vérifier deux hypothèses avant de coder la règle "mandat direct
// agence" (INT) et la génération de référence : la présence/absence de program.developer dans
// les lots déjà importés, et le risque réel de collision sur (ville, n° de lot).
annoncesRouter.get('/diag-promoteurs', exigerConnexion, async (req, res) => {
    try {
        const total = await db.prepare(`SELECT COUNT(*)::int AS n FROM annonces`).get();
        const avecPromoteur = await db
            .prepare(`SELECT COUNT(*)::int AS n FROM annonces WHERE raw_data::jsonb->'program'->'developer' IS NOT NULL`)
            .get();
        const sansPromoteur = await db
            .prepare(
                `SELECT id, external_id, reference, titre, ville, code_postal, prix, scrapee_le,
                        raw_data::jsonb->'program'->'@id' AS program_id
                 FROM annonces
                 WHERE raw_data::jsonb->'program'->'developer' IS NULL
                 ORDER BY scrapee_le DESC LIMIT 30`
            )
            .all();
        const collisionsVilleLot = await db
            .prepare(
                `SELECT ville, reference, COUNT(*)::int AS n
                 FROM annonces
                 WHERE reference IS NOT NULL AND ville IS NOT NULL
                 GROUP BY ville, reference HAVING COUNT(*) > 1
                 ORDER BY n DESC LIMIT 20`
            )
            .all();
        const collisionsDetail = await db
            .prepare(
                `SELECT id, ville, reference, prix,
                        raw_data::jsonb->'program'->'developer'->>'@id' AS developer_id,
                        raw_data::jsonb->'program'->'developer'->>'name' AS developer_name,
                        raw_data::jsonb->'program'->>'@id' AS program_id
                 FROM annonces
                 WHERE (ville, reference) IN (
                     SELECT ville, reference FROM annonces
                     WHERE reference IS NOT NULL AND ville IS NOT NULL
                     GROUP BY ville, reference HAVING COUNT(*) > 1
                 )
                 ORDER BY ville, reference`
            )
            .all();
        const exempleAvecPromoteur = await db
            .prepare(
                `SELECT id, ville, reference,
                        raw_data::jsonb->'law' AS law,
                        raw_data::jsonb->'program'->'law' AS program_law,
                        raw_data::jsonb->'program'->'developer'->'@id' AS developer_id,
                        raw_data::jsonb->'program'->'developer'->'name' AS developer_name
                 FROM annonces
                 WHERE raw_data::jsonb->'program'->'developer' IS NOT NULL
                 ORDER BY scrapee_le DESC LIMIT 5`
            )
            .all();
        res.json({ total: total.n, avecPromoteur: avecPromoteur.n, sansPromoteur, collisionsVilleLot, collisionsDetail, exempleAvecPromoteur });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

// Diagnostic temporaire (à retirer une fois la génération de référence LMNP validée) — vérifie
// empiriquement quelle(s) valeur(s) du champ law brut du lot correspondent à LMNP, en croisant
// avec les recherches dont le filtre était explicitement law=[2] (seule source fiable connue à
// ce jour, voir recherches.url + parseFiltresOtareeDepuisUrl) — jamais une supposition sur la
// valeur numérique du champ.
annoncesRouter.get('/diag-law', exigerConnexion, async (req, res) => {
    try {
        const recherches = await db.prepare(`SELECT id, url FROM recherches`).all();
        const rechercheLmnpSeule = new Set();
        const rechercheAutreLoiSansLmnp = new Set();
        const rechercheSansFiltreLoi = new Set();
        for (const r of recherches) {
            const filters = parseFiltresOtareeDepuisUrl(r.url);
            const law = filters?.law;
            if (!law || (Array.isArray(law) && law.length === 0)) {
                rechercheSansFiltreLoi.add(r.id);
            } else {
                const loiArr = Array.isArray(law) ? law : [law];
                if (loiArr.length === 1 && Number(loiArr[0]) === 2) {
                    rechercheLmnpSeule.add(r.id);
                } else if (!loiArr.map(Number).includes(2)) {
                    rechercheAutreLoiSansLmnp.add(r.id);
                }
            }
        }

        const rows = await db
            .prepare(`SELECT id, recherche_id, raw_data::jsonb->'law' AS law FROM annonces WHERE recherche_id IS NOT NULL`)
            .all();

        const valeursLoiDansRechercheLmnp = {};
        const valeursLoiDansAutreRecherche = {};
        const valeursLoiSansFiltre = {};
        for (const row of rows) {
            const cible = rechercheLmnpSeule.has(row.recherche_id)
                ? valeursLoiDansRechercheLmnp
                : rechercheAutreLoiSansLmnp.has(row.recherche_id)
                ? valeursLoiDansAutreRecherche
                : rechercheSansFiltreLoi.has(row.recherche_id)
                ? valeursLoiSansFiltre
                : null;
            if (!cible) continue;
            const v = String(row.law);
            cible[v] = (cible[v] || 0) + 1;
        }

        res.json({
            nbRecherchesLmnpSeule: rechercheLmnpSeule.size,
            nbRecherchesAutreLoiSansLmnp: rechercheAutreLoiSansLmnp.size,
            nbRecherchesSansFiltreLoi: rechercheSansFiltreLoi.size,
            valeursLoiDansRechercheLmnp,
            valeursLoiDansAutreRecherche,
            valeursLoiSansFiltre,
        });
    } catch (e) {
        res.status(500).json({ erreur: e.message });
    }
});

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
