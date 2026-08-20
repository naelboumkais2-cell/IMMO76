import { db } from '../db.js';
import * as scraperEngine from '../integrations/scraperEngine.js';
import * as hubiflowClient from '../integrations/hubiflowRouter.js';
import { enrichirLot, rechercherLotsOtaree, parseFiltresOtareeDepuisUrl } from '../integrations/otareeSearchClient.js';
import { genererDonneesIA } from '../integrations/aiGenerationClient.js';
import { getMode as getAutoPublishMode, MAX_PAR_RUN } from '../integrations/autoPublishConfig.js';
import {
    demarrerRun,
    marquerLotEnCours,
    incrementerTraites,
    terminerRun,
    estAnnulationDemandee,
    stockerEnAttente,
    recupererEtViderEnAttente,
    getEnAttente,
} from './autoPublishStatus.js';

async function log(type, { annonceId = null, portailId = null, succes, message }) {
    await db.prepare(
        `INSERT INTO logs_api (type, annonce_id, portail_id, succes, message) VALUES (?, ?, ?, ?, ?)`
    ).run(type, annonceId, portailId, succes ? 1 : 0, message);
}

async function resolvePortailsPourAnnonce(annonce) {
    const reglesMatch = await db
        .prepare(
            `SELECT * FROM regles_routage
             WHERE actif = 1 AND (type_bien IS NULL OR type_bien = ?)`
        )
        .all(annonce.type_bien);

    if (reglesMatch.length > 0) {
        const portailIds = [...new Set(reglesMatch.map((r) => r.portail_id))];
        return await db
            .prepare(
                `SELECT * FROM portails WHERE actif = 1 AND id IN (${portailIds.map(() => '?').join(',')})`
            )
            .all(...portailIds);
    }

    return await db.prepare(`SELECT * FROM portails WHERE actif = 1`).all();
}

export async function publierInstance(annonceId, portailId, options = {}) {
    const annonce = await db.prepare(`SELECT * FROM annonces WHERE id = ?`).get(annonceId);
    const portail = await db.prepare(`SELECT * FROM portails WHERE id = ?`).get(portailId);
    const instance = await db
        .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
        .get(annonceId, portailId);
    if (!annonce || !portail || !instance) return;

    await db.prepare(
        `UPDATE annonce_portails SET statut = 'envoyee', maj_le = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(instance.id);

    const result = await hubiflowClient.publish(annonce, portail, instance.mode, options);

    if (result.success) {
        const activationEchouee = result.actif === false && !!result.erreurActivation;
        const statutFinal = activationEchouee ? 'publiee_brouillon' : 'publiee';
        await db.prepare(
            `UPDATE annonce_portails
             SET statut = ?, ad_id_externe = ?, derniere_erreur = ?, maj_le = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(statutFinal, result.adId, activationEchouee ? result.erreurActivation : null, instance.id);
        await log('hubiflow_publish', {
            annonceId,
            portailId,
            succes: true,
            message: activationEchouee
                ? `Brouillon créé (${result.adId}) mais activation échouée : ${result.erreurActivation}`
                : `Publiée (${result.adId})`,
        });
    } else {
        await db.prepare(
            `UPDATE annonce_portails
             SET statut = 'erreur', derniere_erreur = ?, maj_le = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(result.error, instance.id);
        await log('hubiflow_publish', { annonceId, portailId, succes: false, message: result.error });
    }
}

export async function depublierInstance(annonceId, portailId) {
    const portail = await db.prepare(`SELECT * FROM portails WHERE id = ?`).get(portailId);
    const instance = await db
        .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
        .get(annonceId, portailId);
    if (!portail || !instance) return { success: false, error: 'Instance introuvable.' };
    if (!instance.ad_id_externe) return { success: false, error: "Aucune annonce Hubiflow associée à dépublier." };

    const result = await hubiflowClient.depublier(instance.ad_id_externe, portail);

    if (result.success) {
        await db.prepare(
            `UPDATE annonce_portails SET statut = 'depubliee', derniere_erreur = NULL, maj_le = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(instance.id);
        await log('hubiflow_depublish', { annonceId, portailId, succes: true, message: `Dépubliée (${instance.ad_id_externe})` });
    } else {
        await log('hubiflow_depublish', { annonceId, portailId, succes: false, message: result.error });
    }

    return result;
}

const STATUT_PAR_ETAT = { B: 'publiee_brouillon', A: 'publiee', S: 'depubliee' };

export async function synchroniserInstance(annonceId, portailId) {
    const portail = await db.prepare(`SELECT * FROM portails WHERE id = ?`).get(portailId);
    const instance = await db
        .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
        .get(annonceId, portailId);
    if (!portail || !instance) return { success: false, error: 'Instance introuvable.' };
    if (!instance.ad_id_externe) return { success: false, error: 'Aucune annonce Hubiflow associée à vérifier.' };

    const result = await hubiflowClient.lireEtat(instance.ad_id_externe, portail);

    if (result.success) {
        const statutFinal = STATUT_PAR_ETAT[result.etat] || instance.statut;
        await db.prepare(
            `UPDATE annonce_portails
             SET statut = ?, etat_hubiflow_confirme = ?, etat_hubiflow_confirme_le = CURRENT_TIMESTAMP, maj_le = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(statutFinal, result.etat, instance.id);
        await log('hubiflow_sync', { annonceId, portailId, succes: true, message: `État confirmé : ${result.etat}` });
    } else {
        await log('hubiflow_sync', { annonceId, portailId, succes: false, message: result.error });
    }

    return result;
}

async function upsertRecherche(url, nom, resume) {
    await db.prepare(`INSERT INTO recherches (url, nom, resume) VALUES (?, ?, ?) ON CONFLICT(url) DO NOTHING`).run(url, nom || null, resume || null);
    if (nom) {
        await db.prepare(`UPDATE recherches SET nom = ? WHERE url = ?`).run(nom, url);
    }
    return await db.prepare(`SELECT * FROM recherches WHERE url = ?`).get(url);
}

function mapLotOtareeVersAnnonce(lot) {
    const ville = lot.program?.address?.city?.name || null;
    const codePostal = lot.program?.address?.zipCode || null;
    const prix = lot.prices?.[0]?.price ?? null;
    const idBrut = String(lot.id ?? lot.number ?? '').replace(/[^a-zA-Z0-9]+/g, '-');

    return {
        external_id: `OTAREE-${idBrut}`,
        reference: lot.number != null ? String(lot.number) : null,
        titre: `${lot.typology || 'Lot'} ${lot.surface ?? '?'} m²${ville ? ` à ${ville}` : ''}`,
        ville,
        code_postal: codePostal,
        type_bien: lot.typology || null,
        surface: lot.surface ?? null,
        prix,
        raw_data: lot,
    };
}

export async function importerLotsOtaree(url, lotsBruts, nom, resume) {
    const recherche = await upsertRecherche(url, nom, resume);

    const insertAnnonce = db.prepare(
        `INSERT INTO annonces
         (external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, raw_data, donnees_ia, images)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(external_id) DO NOTHING`
    );
    const getByExternalId = db.prepare(`SELECT * FROM annonces WHERE external_id = ?`);
    const insertInstance = db.prepare(
        `INSERT INTO annonce_portails (annonce_id, portail_id, statut, mode)
         VALUES (?, ?, 'en_attente', ?) ON CONFLICT(annonce_id, portail_id) DO NOTHING`
    );

    let nbNouvelles = 0;
    const annoncesTraitees = [];
    for (const lotBrut of lotsBruts) {
        const a = mapLotOtareeVersAnnonce(lotBrut);
        const info = await insertAnnonce.run(
            a.external_id, a.reference, a.titre, a.ville, a.code_postal, a.type_bien, a.surface, a.prix,
            recherche.id, JSON.stringify(a.raw_data ?? {}), null, JSON.stringify([])
        );
        const estNouvelle = info.changes > 0;
        if (estNouvelle) nbNouvelles++;

        const row = await getByExternalId.get(a.external_id);
        const portailsCibles = await resolvePortailsPourAnnonce(row);
        for (const portail of portailsCibles) {
            await insertInstance.run(row.id, portail.id, portail.mode_publication_defaut);
        }
        annoncesTraitees.push({ annonce: row, lotBrut, estNouvelle });
    }

    await db.prepare(
        `INSERT INTO scraper_runs (recherche_id, annonces_trouvees, erreur) VALUES (?, ?, NULL)`
    ).run(recherche.id, lotsBruts.length);
    await db.prepare(
        `UPDATE recherches
         SET derniere_execution_le = CURRENT_TIMESTAMP, dernieres_annonces_trouvees = ?, derniere_erreur = NULL
         WHERE id = ?`
    ).run(lotsBruts.length, recherche.id);

    await log('scraper', {
        succes: true,
        message: `${lotsBruts.length} lot(s) Otaree importé(s) (${nbNouvelles} nouveau(x)) — ${url}`,
    });

    return { rechercheId: recherche.id, nbLots: lotsBruts.length, nbNouvelles, annonces: annoncesTraitees };
}

export async function rescraperRechercheFavorite(recherche) {
    const filters = parseFiltresOtareeDepuisUrl(recherche.url);
    if (!filters) {
        return lancerScrapingEtDiffusion(recherche.url);
    }
    const { lots } = await rechercherLotsOtaree(filters);
    return await importerLotsOtaree(recherche.url, lots);
}

async function apercuCandidats(candidats) {
    const ids = candidats.map(({ annonce }) => annonce.id);
    const portailsParAnnonce = {};
    if (ids.length) {
        const rows = await db
            .prepare(
                `SELECT ap.annonce_id, p.id AS portail_id, p.nom
                 FROM annonce_portails ap JOIN portails p ON p.id = ap.portail_id
                 WHERE ap.annonce_id IN (${ids.map(() => '?').join(',')})`
            )
            .all(...ids);
        for (const r of rows) {
            (portailsParAnnonce[r.annonce_id] ??= []).push({ id: r.portail_id, nom: r.nom });
        }
    }

    return candidats.map(({ annonce, lotBrut }) => ({
        id: annonce.id,
        titre: annonce.titre,
        ville: annonce.ville,
        prix: annonce.prix,
        photo: lotBrut.program?.perspective?.urls?.medium_fit || lotBrut.program?.perspective?.urls?.medium || null,
        portails: portailsParAnnonce[annonce.id] || [],
    }));
}

async function portailsActifsAvecDefaut() {
    return await db
        .prepare(`SELECT id, nom, mode_publication_defaut FROM portails WHERE actif = 1 ORDER BY nom`)
        .all();
}

async function appliquerPortailsChoisis(annonceIds, portailsChoisis) {
    const upsert = db.prepare(
        `INSERT INTO annonce_portails (annonce_id, portail_id, statut, mode)
         VALUES (?, ?, 'en_attente', ?)
         ON CONFLICT(annonce_id, portail_id) DO UPDATE SET mode = EXCLUDED.mode`
    );
    for (const annonceId of annonceIds) {
        for (const { portailId, mode } of portailsChoisis) {
            await upsert.run(annonceId, portailId, mode);
        }
    }
}

async function executerTraitement(candidats, mode, rechercheId, portailIds = null) {
    const aTraiter = candidats.slice(0, MAX_PAR_RUN);

    if (candidats.length > aTraiter.length) {
        await log('auto_publish', {
            succes: true,
            message: `Plafond atteint : ${aTraiter.length}/${candidats.length} lot(s) auto-traités ce run (limite ${MAX_PAR_RUN}), le reste reste en attente (republish manuel possible).`,
        });
    }

    let nbTraites = 0;
    demarrerRun(aTraiter.length, rechercheId, mode);
    let annule = false;
    try {
        for (const { annonce, lotBrut } of aTraiter) {
            if (estAnnulationDemandee()) {
                annule = true;
                await log('auto_publish', {
                    succes: true,
                    message: `Recherche annulée par l'utilisateur — ${nbTraites}/${aTraiter.length} lot(s) traité(s), le reste non traité.`,
                });
                break;
            }
            marquerLotEnCours(annonce.titre);
            try {
                const lotEnrichi = await enrichirLot(lotBrut);
                const { aiData, images } = await genererDonneesIA(lotEnrichi);

                await db.prepare(`UPDATE annonces SET donnees_ia = ?, images = ? WHERE id = ?`)
                    .run(JSON.stringify(aiData), JSON.stringify(images), annonce.id);
                await log('auto_publish', { annonceId: annonce.id, succes: true, message: `Données IA générées automatiquement (mode ${mode})` });

                let instances;
                if (portailIds) {
                    instances = portailIds.length
                        ? await db
                              .prepare(
                                  `SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id IN (${portailIds.map(() => '?').join(',')})`
                              )
                              .all(annonce.id, ...portailIds)
                        : [];
                } else {
                    instances = await db.prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ?`).all(annonce.id);
                }
                for (const instance of instances) {
                    await publierInstance(annonce.id, instance.portail_id, { autoriseAutoPublishOn: mode === 'on' });
                }
                nbTraites++;
            } catch (e) {
                await log('auto_publish', { annonceId: annonce.id, succes: false, message: e.message });
            }
            incrementerTraites();
        }
    } finally {
        terminerRun(annule);
    }

    return { mode, nbCandidats: candidats.length, nbTraites, annule };
}

export async function autoGenererEtPublier(annoncesTraitees, rechercheId = null, options = {}) {
    const mode = getAutoPublishMode();
    if (mode === 'off' || !annoncesTraitees?.length) return { mode, nbCandidats: 0, nbTraites: 0 };

    const candidats = annoncesTraitees.filter(({ annonce, estNouvelle }) =>
        mode === 'test' ? !!annonce.est_annonce_test : estNouvelle
    );

    if (options.confirmationRequise && mode === 'on' && candidats.length > 0) {
        stockerEnAttente({ candidats, mode, rechercheId });
        return {
            mode,
            nbCandidats: candidats.length,
            nbTraites: 0,
            enAttente: true,
            candidatsApercu: await apercuCandidats(candidats),
            portailsDisponibles: await portailsActifsAvecDefaut(),
        };
    }

    return await executerTraitement(candidats, mode, rechercheId);
}

export async function confirmerRunEnAttente(idsSelectionnes = null, portailsChoisis = null) {
    const attente = recupererEtViderEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };

    const candidats = idsSelectionnes
        ? attente.candidats.filter(({ annonce }) => idsSelectionnes.includes(annonce.id))
        : attente.candidats;

    if (idsSelectionnes && candidats.length < attente.candidats.length) {
        await log('auto_publish', {
            succes: true,
            message: `${attente.candidats.length - candidats.length} lot(s) désélectionné(s) manuellement avant confirmation, non traité(s) (restent en attente).`,
        });
    }

    let portailIds = null;
    if (portailsChoisis) {
        await appliquerPortailsChoisis(candidats.map(({ annonce }) => annonce.id), portailsChoisis);
        portailIds = portailsChoisis.map((p) => p.portailId);
        await log('auto_publish', {
            succes: true,
            message: `Portails de publication choisis explicitement sur l'écran de confirmation : ${portailsChoisis.length ? portailsChoisis.map((p) => `#${p.portailId} (${p.mode})`).join(', ') : 'aucun'}.`,
        });
    }

    const result = await executerTraitement(candidats, attente.mode, attente.rechercheId, portailIds);
    return { success: true, ...result };
}

export async function annulerRunEnAttente() {
    const attente = recupererEtViderEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };
    await log('auto_publish', {
        succes: true,
        message: `Traitement automatique annulé avant démarrage par l'utilisateur (${attente.candidats.length} lot(s) resteront en attente, traitables manuellement).`,
    });
    return { success: true };
}

export async function detailLotEnAttente(annonceId) {
    const attente = getEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };

    const candidat = attente.candidats.find(({ annonce }) => annonce.id === annonceId);
    if (!candidat) return { success: false, error: 'Lot introuvable dans le run en attente.' };

    const lotEnrichi = await enrichirLot(structuredClone(candidat.lotBrut));

    const images = (lotEnrichi.images || [])
        .map((img) => img.urls?.medium_fit || img.urls?.medium || img.urls?.large)
        .filter(Boolean);

    return {
        success: true,
        id: candidat.annonce.id,
        titre: candidat.annonce.titre,
        ville: candidat.annonce.ville,
        prix: candidat.annonce.prix,
        surface: candidat.annonce.surface,
        typeBien: candidat.annonce.type_bien,
        etage: lotEnrichi.floor ?? lotEnrichi.normalizedFloor ?? null,
        pieces: lotEnrichi.roomsCount ?? null,
        description: lotEnrichi.description || null,
        images,
    };
}

export async function lancerScrapingEtDiffusion(url) {
    const { url: resolvedUrl, annonces, erreur } = await scraperEngine.run(url);
    const recherche = await upsertRecherche(resolvedUrl);

    await db.prepare(
        `INSERT INTO scraper_runs (recherche_id, annonces_trouvees, erreur) VALUES (?, ?, ?)`
    ).run(recherche.id, annonces.length, erreur);

    await db.prepare(
        `UPDATE recherches
         SET derniere_execution_le = CURRENT_TIMESTAMP, dernieres_annonces_trouvees = ?, derniere_erreur = ?
         WHERE id = ?`
    ).run(annonces.length, erreur, recherche.id);

    if (erreur) {
        await log('scraper', { succes: false, message: `${erreur} — ${resolvedUrl}` });
        return { rechercheId: recherche.id, url: resolvedUrl, nbNouvelles: 0, erreur };
    }

    const insertAnnonce = db.prepare(
        `INSERT INTO annonces
         (external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, raw_data, donnees_ia, images)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(external_id) DO NOTHING`
    );
    const getByExternalId = db.prepare(`SELECT * FROM annonces WHERE external_id = ?`);
    const insertInstance = db.prepare(
        `INSERT INTO annonce_portails (annonce_id, portail_id, statut, mode)
         VALUES (?, ?, 'en_attente', ?) ON CONFLICT(annonce_id, portail_id) DO NOTHING`
    );

    const nouvellesInstances = [];

    for (const a of annonces) {
        await insertAnnonce.run(
            a.external_id, a.reference, a.titre, a.ville, a.code_postal, a.type_bien, a.surface, a.prix,
            recherche.id, JSON.stringify(a.raw_data ?? {}), JSON.stringify(a.donnees_ia ?? {}), JSON.stringify(a.images ?? [])
        );
        const row = await getByExternalId.get(a.external_id);

        const portailsCibles = await resolvePortailsPourAnnonce(row);
        for (const portail of portailsCibles) {
            await insertInstance.run(row.id, portail.id, portail.mode_publication_defaut);
            nouvellesInstances.push({ annonceId: row.id, portailId: portail.id });
        }
    }

    await log('scraper', { succes: true, message: `${annonces.length} annonce(s) trouvée(s) — ${resolvedUrl}` });

    for (const { annonceId, portailId } of nouvellesInstances) {
        await publierInstance(annonceId, portailId);
    }

    return { rechercheId: recherche.id, url: resolvedUrl, nbNouvelles: annonces.length, erreur: null };
}
