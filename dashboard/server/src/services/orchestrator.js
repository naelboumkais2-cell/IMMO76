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

function log(type, { annonceId = null, portailId = null, succes, message }) {
    db.prepare(
        `INSERT INTO logs_api (type, annonce_id, portail_id, succes, message) VALUES (?, ?, ?, ?, ?)`
    ).run(type, annonceId, portailId, succes ? 1 : 0, message);
}

// Détermine vers quels portails router une annonce, à partir des règles configurées.
// Une règle sans type_bien s'applique à toutes les typologies.
// S'il n'existe aucune règle correspondante, on retombe sur tous les portails actifs
// (comportement par défaut : diffuser partout plutôt que nulle part).
function resolvePortailsPourAnnonce(annonce) {
    const reglesMatch = db
        .prepare(
            `SELECT * FROM regles_routage
             WHERE actif = 1 AND (type_bien IS NULL OR type_bien = ?)`
        )
        .all(annonce.type_bien);

    if (reglesMatch.length > 0) {
        const portailIds = [...new Set(reglesMatch.map((r) => r.portail_id))];
        return db
            .prepare(
                `SELECT * FROM portails WHERE actif = 1 AND id IN (${portailIds.map(() => '?').join(',')})`
            )
            .all(...portailIds);
    }

    return db.prepare(`SELECT * FROM portails WHERE actif = 1`).all();
}

// Publie une instance (annonce, portail) via hubiflowClient et met à jour son statut.
// Exportée séparément pour permettre un republish manuel ponctuel depuis la supervision.
// `options.autoriseAutoPublishOn` : uniquement passé par autoGenererEtPublier en mode
// AUTO_PUBLISH=on — jamais par un appel manuel (republish) — voir hubiflowClientReel.js.
export async function publierInstance(annonceId, portailId, options = {}) {
    const annonce = db.prepare(`SELECT * FROM annonces WHERE id = ?`).get(annonceId);
    const portail = db.prepare(`SELECT * FROM portails WHERE id = ?`).get(portailId);
    const instance = db
        .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
        .get(annonceId, portailId);
    if (!annonce || !portail || !instance) return;

    db.prepare(
        `UPDATE annonce_portails SET statut = 'envoyee', maj_le = datetime('now') WHERE id = ?`
    ).run(instance.id);

    const result = await hubiflowClient.publish(annonce, portail, instance.mode, options);

    if (result.success) {
        // Mode 'actif' demandé mais le PATCH d'activation a échoué : le brouillon existe bien
        // sur Hubiflow (pas d'échec complet), mais il faut le distinguer visuellement d'une
        // vraie publication réussie — statut dédié plutôt que masquer l'échec dans un succès.
        const activationEchouee = result.actif === false && !!result.erreurActivation;
        const statutFinal = activationEchouee ? 'publiee_brouillon' : 'publiee';
        db.prepare(
            `UPDATE annonce_portails
             SET statut = ?, ad_id_externe = ?, derniere_erreur = ?, maj_le = datetime('now')
             WHERE id = ?`
        ).run(statutFinal, result.adId, activationEchouee ? result.erreurActivation : null, instance.id);
        log('hubiflow_publish', {
            annonceId,
            portailId,
            succes: true,
            message: activationEchouee
                ? `Brouillon créé (${result.adId}) mais activation échouée : ${result.erreurActivation}`
                : `Publiée (${result.adId})`,
        });
    } else {
        db.prepare(
            `UPDATE annonce_portails
             SET statut = 'erreur', derniere_erreur = ?, maj_le = datetime('now')
             WHERE id = ?`
        ).run(result.error, instance.id);
        log('hubiflow_publish', { annonceId, portailId, succes: false, message: result.error });
    }
}

// Retour arrière immédiat : dépublie/supprime sur Hubiflow (STATUS "S") une instance déjà
// publiée. Chemin séparé et minimal de publierInstance — ne régénère rien, n'a besoin que de
// l'ad_id_externe déjà connu, pour rester rapide et fiable en cas d'urgence (contenu incorrect
// une fois en actif). Déclenché par le bouton "Dépublier" de Supervision.jsx.
export async function depublierInstance(annonceId, portailId) {
    const portail = db.prepare(`SELECT * FROM portails WHERE id = ?`).get(portailId);
    const instance = db
        .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
        .get(annonceId, portailId);
    if (!portail || !instance) return { success: false, error: 'Instance introuvable.' };
    if (!instance.ad_id_externe) return { success: false, error: "Aucune annonce Hubiflow associée à dépublier." };

    const result = await hubiflowClient.depublier(instance.ad_id_externe, portail);

    if (result.success) {
        db.prepare(
            `UPDATE annonce_portails SET statut = 'depubliee', derniere_erreur = NULL, maj_le = datetime('now') WHERE id = ?`
        ).run(instance.id);
        log('hubiflow_depublish', { annonceId, portailId, succes: true, message: `Dépubliée (${instance.ad_id_externe})` });
    } else {
        log('hubiflow_depublish', { annonceId, portailId, succes: false, message: result.error });
    }

    return result;
}

// Resynchronisation manuelle : relit l'état RÉEL sur Hubiflow (lecture seule, aucune mutation)
// et met à jour `statut` en conséquence — utile si un changement a été fait directement sur
// Hubiflow, hors de ce dashboard (ex: quelqu'un repasse une annonce en brouillon depuis leur
// interface). Ne touche jamais `mode` (notre intention pour le prochain republish, distincte de
// l'état observé) — stocke l'état confirmé séparément (`etat_hubiflow_confirme`) pour que
// l'UI puisse afficher clairement "confirmé" vs "intention" sans les confondre.
const STATUT_PAR_ETAT = { B: 'publiee_brouillon', A: 'publiee', S: 'depubliee' };

export async function synchroniserInstance(annonceId, portailId) {
    const portail = db.prepare(`SELECT * FROM portails WHERE id = ?`).get(portailId);
    const instance = db
        .prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id = ?`)
        .get(annonceId, portailId);
    if (!portail || !instance) return { success: false, error: 'Instance introuvable.' };
    if (!instance.ad_id_externe) return { success: false, error: 'Aucune annonce Hubiflow associée à vérifier.' };

    const result = await hubiflowClient.lireEtat(instance.ad_id_externe, portail);

    if (result.success) {
        const statutFinal = STATUT_PAR_ETAT[result.etat] || instance.statut;
        db.prepare(
            `UPDATE annonce_portails
             SET statut = ?, etat_hubiflow_confirme = ?, etat_hubiflow_confirme_le = datetime('now'), maj_le = datetime('now')
             WHERE id = ?`
        ).run(statutFinal, result.etat, instance.id);
        log('hubiflow_sync', { annonceId, portailId, succes: true, message: `État confirmé : ${result.etat}` });
    } else {
        log('hubiflow_sync', { annonceId, portailId, succes: false, message: result.error });
    }

    return result;
}

// Retrouve la recherche associée à une URL, ou la crée si c'est la première fois qu'on la voit.
// `nom` optionnel : si fourni, écrase le nom existant (dernier nom donné qui gagne) — permet de
// renommer une campagne en relançant la même recherche avec un nom différent.
// `resume` : résumé lisible des filtres (généré côté client), stocké seulement à la création —
// l'URL détermine les filtres de façon déterministe, donc il ne peut pas changer pour une même
// URL, pas besoin de le réécrire à chaque run.
function upsertRecherche(url, nom, resume) {
    db.prepare(`INSERT OR IGNORE INTO recherches (url, nom, resume) VALUES (?, ?, ?)`).run(url, nom || null, resume || null);
    if (nom) {
        db.prepare(`UPDATE recherches SET nom = ? WHERE url = ?`).run(nom, url);
    }
    return db.prepare(`SELECT * FROM recherches WHERE url = ?`).get(url);
}

// Mappe un lot brut Otaree (structure api.link-app.immo, telle qu'envoyée par
// extension-chrome/Otaree/) vers la forme attendue par la table annonces — même mapping
// ville/code_postal que Ubiflow-Auto-API/server.js (lot.program.address).
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

// Importe de vrais lots scrapés (recherche server-side otaree-search, ou copie du JSON que
// l'extension Otaree écrit aussi dans Downloads — voir extension-chrome/Otaree/background.js).
// Route vers les portails pour que la Supervision montre où ça irait. Ne génère/publie PAS par
// elle-même (donnees_ia/images restent vides ici) — coexistence avec le pipeline
// Downloads -> Watcher -> Hubiflow existant. L'appelant décide ensuite s'il déclenche
// autoGenererEtPublier() sur le résultat, selon AUTO_PUBLISH (voir routes/scraper.js).
export function importerLotsOtaree(url, lotsBruts, nom, resume) {
    const recherche = upsertRecherche(url, nom, resume);

    const insertAnnonce = db.prepare(
        `INSERT OR IGNORE INTO annonces
         (external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, raw_data, donnees_ia, images)
         VALUES (@external_id, @reference, @titre, @ville, @code_postal, @type_bien, @surface, @prix, @recherche_id, @raw_data, @donnees_ia, @images)`
    );
    const getByExternalId = db.prepare(`SELECT * FROM annonces WHERE external_id = ?`);
    const insertInstance = db.prepare(
        `INSERT OR IGNORE INTO annonce_portails (annonce_id, portail_id, statut, mode)
         VALUES (?, ?, 'en_attente', ?)`
    );

    let nbNouvelles = 0;
    const annoncesTraitees = [];
    for (const lotBrut of lotsBruts) {
        const a = mapLotOtareeVersAnnonce(lotBrut);
        const info = insertAnnonce.run({
            ...a,
            recherche_id: recherche.id,
            raw_data: JSON.stringify(a.raw_data ?? {}),
            donnees_ia: null,
            images: JSON.stringify([]),
        });
        const estNouvelle = info.changes > 0;
        if (estNouvelle) nbNouvelles++;

        const row = getByExternalId.get(a.external_id);
        const portailsCibles = resolvePortailsPourAnnonce(row);
        for (const portail of portailsCibles) {
            insertInstance.run(row.id, portail.id, portail.mode_publication_defaut);
        }
        annoncesTraitees.push({ annonce: row, lotBrut, estNouvelle });
    }

    db.prepare(
        `INSERT INTO scraper_runs (recherche_id, annonces_trouvees, erreur) VALUES (?, ?, NULL)`
    ).run(recherche.id, lotsBruts.length);
    db.prepare(
        `UPDATE recherches
         SET derniere_execution_le = datetime('now'), dernieres_annonces_trouvees = ?, derniere_erreur = NULL
         WHERE id = ?`
    ).run(lotsBruts.length, recherche.id);

    log('scraper', {
        succes: true,
        message: `${lotsBruts.length} lot(s) Otaree importé(s) (${nbNouvelles} nouveau(x)) — ${url}`,
    });

    return { rechercheId: recherche.id, nbLots: lotsBruts.length, nbNouvelles, annonces: annoncesTraitees };
}

// Rescrape programmé d'une recherche favorite (voir scheduler dans index.js) : importe les
// nouveaux lots (visibles en Supervision, comptés pour le badge de notifications) mais ne
// déclenche JAMAIS autoGenererEtPublier — même si AUTO_PUBLISH=on. Publier reste toujours une
// action manuelle explicite ; un run automatique en arrière-plan qui publierait tout seul
// pendant une absence serait une surprise trop risquée pour ce que ce mécanisme doit faire
// (juste signaler les nouveaux lots).
//
// Ne fonctionne que pour les recherches créées via otaree-search (URL reconnaissable, voir
// parseFiltresOtareeDepuisUrl) : les recherches plus anciennes retombent sur l'ancien moteur
// mock (lancerScrapingEtDiffusion), pour ne rien casser côté rétrocompatibilité.
export async function rescraperRechercheFavorite(recherche) {
    const filters = parseFiltresOtareeDepuisUrl(recherche.url);
    if (!filters) {
        return lancerScrapingEtDiffusion(recherche.url);
    }
    const { lots } = await rechercherLotsOtaree(filters);
    return importerLotsOtaree(recherche.url, lots);
}

// Aperçu léger de chaque lot candidat pour l'écran de confirmation — titre/ville/prix déjà sur
// la ligne `annonce` (import déjà fait), photo prise directement sur le lot brut Otaree
// (program.perspective, déjà présent sur le résultat de recherche, sans enrichissement ni appel
// réseau supplémentaire — l'enrichissement lui-même n'a lieu que dans executerTraitement).
//
// `portails` par lot (pas juste un total agrégé) : permet au client de recalculer "Portails
// concernés" en direct au fil de la sélection/désélection de lots, sans aller-retour serveur —
// un total figé sur l'ensemble des candidats trouvés serait trompeur si l'utilisateur décoche
// tous les lots d'un portail précis.
function apercuCandidats(candidats) {
    const ids = candidats.map(({ annonce }) => annonce.id);
    const portailsParAnnonce = {};
    if (ids.length) {
        const rows = db
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

// Portails actuellement actifs, avec leur mode par défaut — sert à préremplir la section
// "Portails de publication" de l'écran de confirmation (voir confirmerRunEnAttente / route
// otaree-search) : liste complète, pas seulement ceux qu'une règle de routage aurait résolus,
// pour que l'utilisateur puisse aussi ajouter un portail que les règles n'auraient pas choisi.
function portailsActifsAvecDefaut() {
    return db
        .prepare(`SELECT id, nom, mode_publication_defaut FROM portails WHERE actif = 1 ORDER BY nom`)
        .all();
}

// Applique le choix explicite de portails/mode (voir écran de confirmation) aux candidats
// confirmés : crée les lignes annonce_portails manquantes pour un portail que les règles de
// routage n'auraient pas résolu, et met à jour le mode des lignes existantes selon le choix.
// Les portails NON choisis ne sont jamais touchés/supprimés — leurs lignes restent en l'état
// (visibles/publiables manuellement plus tard en Supervision), simplement ignorées par ce run
// (voir le filtre portailIds dans executerTraitement).
function appliquerPortailsChoisis(annonceIds, portailsChoisis) {
    const upsert = db.prepare(
        `INSERT INTO annonce_portails (annonce_id, portail_id, statut, mode)
         VALUES (?, ?, 'en_attente', ?)
         ON CONFLICT(annonce_id, portail_id) DO UPDATE SET mode = excluded.mode`
    );
    for (const annonceId of annonceIds) {
        for (const { portailId, mode } of portailsChoisis) {
            upsert.run(annonceId, portailId, mode);
        }
    }
}

// Boucle séquentielle proprement dite (un lot à la fois, comme folderQueue dans
// Ubiflow-Auto-API/server.js) — extraite d'autoGenererEtPublier pour être appelable soit tout de
// suite, soit après une confirmation manuelle différée (voir confirmerRunEnAttente).
//
// `portailIds` (optionnel) : restreint la publication de chaque candidat à ces portails
// uniquement — reflète le choix explicite fait sur l'écran de confirmation. Si omis (mode
// 'test', qui ne passe pas par cet écran), comportement inchangé : publie vers tous les
// portails déjà associés au lot (routage automatique par règles).
async function executerTraitement(candidats, mode, rechercheId, portailIds = null) {
    const aTraiter = candidats.slice(0, MAX_PAR_RUN);

    if (candidats.length > aTraiter.length) {
        log('auto_publish', {
            succes: true,
            message: `Plafond atteint : ${aTraiter.length}/${candidats.length} lot(s) auto-traités ce run (limite ${MAX_PAR_RUN}), le reste reste en attente (republish manuel possible).`,
        });
    }

    let nbTraites = 0;
    demarrerRun(aTraiter.length, rechercheId, mode);
    let annule = false;
    try {
        for (const { annonce, lotBrut } of aTraiter) {
            // Vérifié en tout début d'itération, jamais en plein milieu d'un lot déjà commencé
            // (enrichissement/génération/publication) — le lot en cours va toujours jusqu'au
            // bout, seul le lot SUIVANT n'est pas démarré.
            if (estAnnulationDemandee()) {
                annule = true;
                log('auto_publish', {
                    succes: true,
                    message: `Recherche annulée par l'utilisateur — ${nbTraites}/${aTraiter.length} lot(s) traité(s), le reste non traité.`,
                });
                break;
            }
            marquerLotEnCours(annonce.titre);
            try {
                const lotEnrichi = await enrichirLot(lotBrut);
                const { aiData, images } = await genererDonneesIA(lotEnrichi);

                db.prepare(`UPDATE annonces SET donnees_ia = ?, images = ? WHERE id = ?`)
                    .run(JSON.stringify(aiData), JSON.stringify(images), annonce.id);
                log('auto_publish', { annonceId: annonce.id, succes: true, message: `Données IA générées automatiquement (mode ${mode})` });

                // portailIds vide (tableau, pas null) : l'utilisateur a décoché tous les portails
                // sur l'écran de confirmation — ne rien publier pour ce lot plutôt qu'un IN () invalide.
                let instances;
                if (portailIds) {
                    instances = portailIds.length
                        ? db
                              .prepare(
                                  `SELECT * FROM annonce_portails WHERE annonce_id = ? AND portail_id IN (${portailIds.map(() => '?').join(',')})`
                              )
                              .all(annonce.id, ...portailIds)
                        : [];
                } else {
                    instances = db.prepare(`SELECT * FROM annonce_portails WHERE annonce_id = ?`).all(annonce.id);
                }
                for (const instance of instances) {
                    await publierInstance(annonce.id, instance.portail_id, { autoriseAutoPublishOn: mode === 'on' });
                }
                nbTraites++;
            } catch (e) {
                log('auto_publish', { annonceId: annonce.id, succes: false, message: e.message });
            }
            incrementerTraites();
        }
    } finally {
        terminerRun(annule);
    }

    return { mode, nbCandidats: candidats.length, nbTraites, annule };
}

// Auto-génération IA + publication déclenchée directement depuis otaree-search — "un seul
// geste (lancer la recherche) déclenche tout". Ne fait rien si AUTO_PUBLISH=off (défaut) :
// comportement inchangé.
//
// mode 'test' : uniquement les annonces marquées est_annonce_test=1, nouvelles ou déjà
//   connues — permet de retrouver un lot précis en relançant la même recherche. Traité
//   immédiatement, ne passe PAS par l'écran de confirmation (déjà un mécanisme de validation
//   manuelle séparé : le flag est_annonce_test posé lot par lot).
// mode 'on' : uniquement les annonces réellement nouvelles de cette recherche.
//
// `options.confirmationRequise` (toggle "Demander confirmation avant envoi" du dashboard) : si
// vrai ET mode 'on' ET au moins un candidat, ne traite RIEN tout de suite — les candidats sont
// mis en attente (voir autoPublishStatus.stockerEnAttente) et un récapitulatif (lots + portails/
// mode par défaut) est renvoyé. Rien n'est envoyé à Hubiflow tant que confirmerRunEnAttente()
// n'a pas été appelé explicitement (voir routes/scraper.js, POST /auto-publish-confirm). Si
// faux (comportement par défaut du switch) : publication immédiate, en utilisant le routage
// automatique par règles et le mode par défaut de chaque portail, sans validation manuelle.
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
            candidatsApercu: apercuCandidats(candidats),
            portailsDisponibles: portailsActifsAvecDefaut(),
        };
    }

    return executerTraitement(candidats, mode, rechercheId);
}

// Déclenche le traitement d'un run mis en attente par la confirmation obligatoire du mode 'on'
// — voir autoGenererEtPublier.
//
// `idsSelectionnes` (ids d'annonces, voir la grille de l'écran de confirmation) : si fourni,
// ne traite QUE ce sous-ensemble des candidats stockés — l'utilisateur a pu décocher des lots
// qui lui semblaient suspects (mauvais prix, mauvaise ville, doublon) avant de confirmer. Les
// lots non retenus ne sont pas perdus : ils restent des annonces en_attente normales,
// traitables manuellement plus tard. Si omis, comportement inchangé (tous les candidats).
//
// `portailsChoisis` ([{portailId, mode}]) : choix explicite fait sur la section "Portails de
// publication" de l'écran de confirmation — remplace le routage automatique des règles pour ce
// run précis (voir appliquerPortailsChoisis/executerTraitement). Si omis, comportement de repli
// : publie vers tous les portails déjà associés à chaque lot (routage automatique inchangé).
export async function confirmerRunEnAttente(idsSelectionnes = null, portailsChoisis = null) {
    const attente = recupererEtViderEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };

    const candidats = idsSelectionnes
        ? attente.candidats.filter(({ annonce }) => idsSelectionnes.includes(annonce.id))
        : attente.candidats;

    if (idsSelectionnes && candidats.length < attente.candidats.length) {
        log('auto_publish', {
            succes: true,
            message: `${attente.candidats.length - candidats.length} lot(s) désélectionné(s) manuellement avant confirmation, non traité(s) (restent en attente).`,
        });
    }

    let portailIds = null;
    if (portailsChoisis) {
        appliquerPortailsChoisis(candidats.map(({ annonce }) => annonce.id), portailsChoisis);
        portailIds = portailsChoisis.map((p) => p.portailId);
        log('auto_publish', {
            succes: true,
            message: `Portails de publication choisis explicitement sur l'écran de confirmation : ${portailsChoisis.length ? portailsChoisis.map((p) => `#${p.portailId} (${p.mode})`).join(', ') : 'aucun'}.`,
        });
    }

    const result = await executerTraitement(candidats, attente.mode, attente.rechercheId, portailIds);
    return { success: true, ...result };
}

// Abandonne un run en attente sans rien traiter — les lots restent importés/routés (visibles
// dans Supervision), traitables manuellement via republish, mais jamais générés/publiés
// automatiquement pour ce run.
export function annulerRunEnAttente() {
    const attente = recupererEtViderEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };
    log('auto_publish', {
        succes: true,
        message: `Traitement automatique annulé avant démarrage par l'utilisateur (${attente.candidats.length} lot(s) resteront en attente, traitables manuellement).`,
    });
    return { success: true };
}

// Détail d'un lot du run en attente, pour la carte cliquée sur l'écran de confirmation —
// enrichissement (photos, description) déclenché uniquement pour CE lot, au moment du clic, pas
// pour tous les candidats d'avance. Le lot brut est déjà en mémoire (stocké par
// autoGenererEtPublier), pas besoin de refaire la recherche Otaree — juste l'enrichir.
//
// N'inclut JAMAIS de titre/description/DPE générés par IA : cette génération n'a lieu qu'après
// confirmation (voir executerTraitement), donc `donnees_ia` est encore NULL à ce stade — rien de
// "réel" à montrer pour ces champs avant que l'utilisateur ait confirmé. Principe à respecter
// partout ailleurs dans le dashboard où un contenu IA pourrait être affiché en anticipation.
export async function detailLotEnAttente(annonceId) {
    const attente = getEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };

    const candidat = attente.candidats.find(({ annonce }) => annonce.id === annonceId);
    if (!candidat) return { success: false, error: 'Lot introuvable dans le run en attente.' };

    // Clone avant enrichissement : ne jamais muter le lotBrut stocké, réutilisé tel quel pour le
    // vrai traitement si l'utilisateur confirme ensuite.
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

// Flux principal : scraper une recherche (existante si `url` est fournie, sinon nouvelle) ->
// enregistrer les nouvelles annonces -> router vers les portails concernés -> publier
// automatiquement (pas de validation manuelle requise).
//
// `url` correspond à la page de résultats Autari déjà scrapée par l'extension Otaree. Omise,
// scraperEngine en simule une nouvelle (voir son contrat) ; fournie, ce run est rattaché à la
// recherche existante identifiée par cette URL (rescraping manuel ou programmé).
export async function lancerScrapingEtDiffusion(url) {
    const { url: resolvedUrl, annonces, erreur } = await scraperEngine.run(url);
    const recherche = upsertRecherche(resolvedUrl);

    db.prepare(
        `INSERT INTO scraper_runs (recherche_id, annonces_trouvees, erreur) VALUES (?, ?, ?)`
    ).run(recherche.id, annonces.length, erreur);

    db.prepare(
        `UPDATE recherches
         SET derniere_execution_le = datetime('now'), dernieres_annonces_trouvees = ?, derniere_erreur = ?
         WHERE id = ?`
    ).run(annonces.length, erreur, recherche.id);

    if (erreur) {
        log('scraper', { succes: false, message: `${erreur} — ${resolvedUrl}` });
        return { rechercheId: recherche.id, url: resolvedUrl, nbNouvelles: 0, erreur };
    }

    const insertAnnonce = db.prepare(
        `INSERT OR IGNORE INTO annonces
         (external_id, reference, titre, ville, code_postal, type_bien, surface, prix, recherche_id, raw_data, donnees_ia, images)
         VALUES (@external_id, @reference, @titre, @ville, @code_postal, @type_bien, @surface, @prix, @recherche_id, @raw_data, @donnees_ia, @images)`
    );
    const getByExternalId = db.prepare(`SELECT * FROM annonces WHERE external_id = ?`);
    const insertInstance = db.prepare(
        `INSERT OR IGNORE INTO annonce_portails (annonce_id, portail_id, statut, mode)
         VALUES (?, ?, 'en_attente', ?)`
    );

    const nouvellesInstances = [];

    for (const a of annonces) {
        insertAnnonce.run({
            ...a,
            recherche_id: recherche.id,
            raw_data: JSON.stringify(a.raw_data ?? {}),
            donnees_ia: JSON.stringify(a.donnees_ia ?? {}),
            images: JSON.stringify(a.images ?? []),
        });
        const row = getByExternalId.get(a.external_id);

        const portailsCibles = resolvePortailsPourAnnonce(row);
        for (const portail of portailsCibles) {
            insertInstance.run(row.id, portail.id, portail.mode_publication_defaut);
            nouvellesInstances.push({ annonceId: row.id, portailId: portail.id });
        }
    }

    log('scraper', { succes: true, message: `${annonces.length} annonce(s) trouvée(s) — ${resolvedUrl}` });

    // Diffusion automatique : pas d'étape de validation manuelle dans le flux principal.
    for (const { annonceId, portailId } of nouvellesInstances) {
        await publierInstance(annonceId, portailId);
    }

    return { rechercheId: recherche.id, url: resolvedUrl, nbNouvelles: annonces.length, erreur: null };
}
