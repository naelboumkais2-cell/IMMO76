import { db } from '../db.js';
import * as scraperEngine from '../integrations/scraperEngine.js';
import * as hubiflowClient from '../integrations/hubiflowRouter.js';
import { enrichirLot, obtenirJwtFrais, rechercherLotsOtaree, parseFiltresOtareeDepuisUrl } from '../integrations/otareeSearchClient.js';
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
import { utilisateurActuelId } from './requestContext.js';
import { estEnPause, obtenirEtatPause } from './depenseMonitor.js';
import { genererReferenceLmnp } from './referenceGenerator.js';
import { estLotLmnp } from './dispositifFiscal.js';

// utilisateur_id vient du contexte de requête (voir requestContext.js/index.js), jamais passé
// explicitement ici — évite d'ajouter un paramètre utilisateurId à chaque fonction de ce
// fichier juste pour le faire transiter jusqu'ici. Reste null pour les actions sans humain
// connecté (rescraping programmé par cron, par ex.).
async function log(type, { annonceId = null, portailId = null, succes, message }) {
    await db.prepare(
        `INSERT INTO logs_api (type, annonce_id, portail_id, succes, message, utilisateur_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(type, annonceId, portailId, succes ? 1 : 0, message, utilisateurActuelId());
}

// Dispositif du lot ('lmnp' | 'non_lmnp' | null si indéterminé — raw_data absent/illisible, ou
// mode mock qui n'a pas de champ `law`) — voir dispositifFiscal.js pour le détail du bit utilisé.
// null : aucune règle "lmnp"/"non_lmnp" ne matchera (dispositif = NULL en SQL n'égale jamais
// 'lmnp' ni 'non_lmnp'), donc on retombe sur le comportement de secours existant plus bas — jamais
// un lot silencieusement non publié nulle part faute de dispositif connu.
function dispositifPourAnnonce(annonce) {
    try {
        const raw = typeof annonce.raw_data === 'string' ? JSON.parse(annonce.raw_data) : annonce.raw_data;
        if (typeof raw?.law !== 'number') return null;
        return estLotLmnp(raw) ? 'lmnp' : 'non_lmnp';
    } catch {
        return null;
    }
}

async function resolvePortailsPourAnnonce(annonce) {
    const dispositif = dispositifPourAnnonce(annonce);
    const reglesMatch = await db
        .prepare(
            `SELECT * FROM regles_routage
             WHERE actif = 1
               AND (type_bien IS NULL OR type_bien = ?)
               AND (dispositif IS NULL OR dispositif = ?)`
        )
        .all(annonce.type_bien, dispositif);

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

export async function importerLotsOtaree(url, lotsBruts, nom, resume, onProgress = () => {}) {
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
        onProgress(annoncesTraitees.length, lotsBruts.length);
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

    return await Promise.all(
        candidats.map(async ({ annonce, lotBrut }) => {
            const referenceGeneree = await genererReferenceLmnp(annonce, lotBrut);
            // Hypothèse INT (mandat direct agence) pas encore confirmée sur un vrai cas — voir
            // referenceGenerator.js. Loggé explicitement à chaque occurrence pour que
            // l'utilisateur puisse vérifier chaque premier cas avant de le considérer acquis.
            if (referenceGeneree?.startsWith('INT-')) {
                await log('auto_publish', {
                    annonceId: annonce.id,
                    succes: true,
                    message: `Référence INT générée automatiquement (${referenceGeneree}) — hypothèse "mandat direct" non encore confirmée sur un cas réel, à vérifier manuellement.`,
                });
            }
            return {
                id: annonce.id,
                titre: annonce.titre,
                ville: annonce.ville,
                prix: annonce.prix,
                photo: lotBrut.program?.perspective?.urls?.medium_fit || lotBrut.program?.perspective?.urls?.medium || null,
                portails: portailsParAnnonce[annonce.id] || [],
                referenceGeneree,
            };
        })
    );
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

// Nombre de lots traités en parallèle pour l'enrichissement + la génération IA (les deux seules
// étapes indépendantes d'un lot à l'autre — voir audit pipeline). La publication Hubiflow reste
// volontairement hors de ce groupe, strictement séquentielle, lot par lot puis portail par
// portail, exactement comme avant. Valeur prudente par défaut (pas de palier OpenAI/Otaree
// confirmé) — à ajuster si besoin une fois un vrai palier de compte vérifié.
const CONCURRENCE_ENRICHISSEMENT_IA = 4;

function decouperEnGroupes(liste, taille) {
    const groupes = [];
    for (let i = 0; i < liste.length; i += taille) groupes.push(liste.slice(i, i + taille));
    return groupes;
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
        const groupes = decouperEnGroupes(aTraiter, CONCURRENCE_ENRICHISSEMENT_IA);
        for (const groupe of groupes) {
            // Vérifiée entre chaque GROUPE, pas entre chaque lot : granularité assumée (voir
            // audit pipeline) — jusqu'à (CONCURRENCE_ENRICHISSEMENT_IA - 1) lots de plus que la
            // demande d'annulation peuvent terminer leur enrichissement/génération avant l'arrêt
            // effectif, mais rien n'est jamais publié au-delà de ce point d'arrêt (la boucle de
            // publication plus bas reste, elle, strictement séquentielle et s'arrête net).
            if (estAnnulationDemandee()) {
                annule = true;
                await log('auto_publish', {
                    succes: true,
                    message: `Recherche annulée par l'utilisateur — ${nbTraites}/${aTraiter.length} lot(s) traité(s), le reste non traité.`,
                });
                break;
            }

            // Plafond de dépense (voir services/depenseMonitor.js) : même point de coupure que
            // l'annulation manuelle, entre deux groupes, jamais en plein milieu d'un lot déjà
            // commencé. Ne touche que génération IA + auto-publication, jamais la recherche —
            // les lots déjà en attente restent traitables manuellement après la reprise.
            if (await estEnPause()) {
                annule = true;
                await log('auto_publish', {
                    succes: true,
                    message: `Pause automatique (plafond de dépense atteint) — ${nbTraites}/${aTraiter.length} lot(s) traité(s), le reste non traité. Reprise manuelle nécessaire (Réglages).`,
                });
                break;
            }

            marquerLotEnCours(
                groupe.length > 1
                    ? `${groupe.length} lots en cours (enrichissement + génération IA) : ${groupe.map(({ annonce }) => annonce.titre).join(', ')}`
                    : groupe[0].annonce.titre
            );

            // Un seul jeton Otaree pour tout le groupe (voir enrichirLot/obtenirJwtFrais) —
            // évite une rafale de rafraîchissements simultanés si chaque lot en demandait un.
            const jetonPartage = await obtenirJwtFrais();

            const resultats = await Promise.allSettled(
                groupe.map(async ({ lotBrut, imagesSelection }) => {
                    const lotEnrichi = await enrichirLot(lotBrut, jetonPartage);
                    return genererDonneesIA(lotEnrichi, imagesSelection);
                })
            );

            // Écriture en base + publication : strictement séquentielle, lot par lot puis
            // portail par portail, dans l'ordre d'origine du groupe — comportement inchangé par
            // rapport à avant, la parallélisation s'arrête à la ligne au-dessus.
            for (let i = 0; i < groupe.length; i++) {
                const { annonce } = groupe[i];
                const resultat = resultats[i];
                marquerLotEnCours(annonce.titre);

                if (resultat.status === 'rejected') {
                    const raison = resultat.reason;
                    await log('auto_publish', { annonceId: annonce.id, succes: false, message: raison?.message || String(raison) });
                    incrementerTraites();
                    continue;
                }

                try {
                    const { aiData, images, alerteConformite } = resultat.value;
                    await db.prepare(`UPDATE annonces SET donnees_ia = ?, images = ? WHERE id = ?`)
                        .run(JSON.stringify(aiData), JSON.stringify(images), annonce.id);
                    await log('auto_publish', { annonceId: annonce.id, succes: true, message: `Données IA générées automatiquement (mode ${mode})` });

                    // Garde-fou formulations interdites / fuites de structure (voir
                    // detecterProblemesConformite, Ubiflow-Auto-API) : le texte a déjà survécu à
                    // une tentative de correction automatique côté IA et reste problématique — le
                    // texte généré est conservé en base (relecture/correction manuelle possible),
                    // mais la publication automatique de CE lot est annulée, pas celle du run
                    // entier. Republish manuel depuis Supervision une fois le texte corrigé.
                    if (alerteConformite && alerteConformite.length) {
                        await log('auto_publish', {
                            annonceId: annonce.id,
                            succes: false,
                            message: `Alerte conformité : formulation(s) interdite(s) toujours présente(s) après nouvelle tentative (${alerteConformite.join(', ')}) — publication automatique annulée pour ce lot, vérification manuelle requise (texte déjà généré, republish possible depuis Supervision après correction).`,
                        });
                        incrementerTraites();
                        continue;
                    }

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
        }
    } finally {
        terminerRun(annule);
    }

    return { mode, nbCandidats: candidats.length, nbTraites, annule };
}

export async function autoGenererEtPublier(annoncesTraitees, rechercheId = null) {
    const mode = getAutoPublishMode();
    if (mode === 'off' || !annoncesTraitees?.length) return { mode, nbCandidats: 0, nbTraites: 0 };

    const candidats = annoncesTraitees.filter(({ annonce, estNouvelle }) =>
        mode === 'test' ? !!annonce.est_annonce_test : estNouvelle
    );

    // Plafond de dépense (voir services/depenseMonitor.js) : vérifié ici aussi, avant même un
    // éventuel écran de confirmation — sinon un run déjà en pause afficherait quand même
    // l'écran "Confirmer et lancer" pour rien, avant de s'arrêter immédiatement une fois
    // confirmé. Les lots restent importés/routés normalement (voir importerLotsOtaree, appelé
    // avant cette fonction), seule la génération/publication automatique est court-circuitée.
    if (candidats.length > 0 && (await estEnPause())) {
        const pause = await obtenirEtatPause();
        await log('auto_publish', {
            succes: true,
            message: `Pause automatique (plafond de dépense atteint, ${pause?.service}) — ${candidats.length} lot(s) restent en attente, non traités. Reprise manuelle nécessaire (Réglages).`,
        });
        return { mode, nbCandidats: candidats.length, nbTraites: 0, annule: true };
    }

    // Écran de confirmation systématique pour toute publication réelle (mode 'on') — plus
    // optionnel : c'est ce qui rend sûr de laisser "Annonce active" comme mode par défaut d'un
    // portail (voir RoutingConfig.jsx), aucune publication ne part plus jamais sans validation
    // humaine explicite. Le mode 'test' reste direct (déjà indépendant de ceci auparavant), et le
    // rescraping programmé (scheduler, voir index.js) n'appelle jamais cette fonction du tout.
    if (mode === 'on' && candidats.length > 0) {
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

export async function confirmerRunEnAttente(idsSelectionnes = null, portailsChoisis = null, referencesEditees = null, imagesEditees = null) {
    const attente = recupererEtViderEnAttente();
    if (!attente) return { success: false, error: 'Aucun run en attente de confirmation.' };

    const candidatsFiltres = idsSelectionnes
        ? attente.candidats.filter(({ annonce }) => idsSelectionnes.includes(annonce.id))
        : attente.candidats;

    // Sélection manuelle de photos (mettre en premier/exclure, voir ScraperControl.jsx) —
    // attachée en mémoire à chaque candidat, même durée de vie que le reste du run (pas de
    // colonne DB : comme lotBrut, ne survit pas à un redémarrage serveur, mais le run entier ne
    // le fait déjà pas non plus). Lue par executerTraitement juste avant genererDonneesIA.
    const candidats =
        imagesEditees && typeof imagesEditees === 'object'
            ? candidatsFiltres.map((c) => ({ ...c, imagesSelection: imagesEditees[c.annonce.id] || null }))
            : candidatsFiltres;

    if (idsSelectionnes && candidats.length < attente.candidats.length) {
        await log('auto_publish', {
            succes: true,
            message: `${attente.candidats.length - candidats.length} lot(s) désélectionné(s) manuellement avant confirmation, non traité(s) (restent en attente).`,
        });
    }

    // Référence LMNP (générée automatiquement puis éventuellement corrigée à la main sur l'écran
    // de confirmation) : enregistrée ici, avant l'éventuelle publication, pour ne jamais la
    // perdre même si le traitement s'arrête en cours de route (plafond de dépense, annulation).
    if (referencesEditees && typeof referencesEditees === 'object') {
        const majReference = db.prepare(`UPDATE annonces SET reference_generee = ? WHERE id = ?`);
        for (const { annonce } of candidats) {
            const valeur = referencesEditees[annonce.id];
            if (typeof valeur === 'string' && valeur.trim()) {
                await majReference.run(valeur.trim(), annonce.id);
            }
        }
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

    // Fire-and-forget : executerTraitement peut prendre 25-30 min sur un gros volume, largement
    // au-delà des 120s du proxy externe Vercel — l'attendre ici faisait échouer la requête HTTP
    // côté navigateur bien avant la fin réelle du traitement (constaté en conditions réelles,
    // ~200 lots publiés sur Hubiflow après que l'écran ait affiché une erreur). Le suivi ne
    // dépend plus de cette réponse : le client interroge déjà /auto-publish-status en continu
    // (autoPublishStatus.js, mis à jour par executerTraitement lui-même via demarrerRun/
    // incrementerTraites/terminerRun), qui reste la seule source de vérité pour la progression
    // et la fin du traitement.
    executerTraitement(candidats, attente.mode, attente.rechercheId, portailIds).catch((e) => {
        console.error('[confirmerRunEnAttente] échec en arrière-plan :', e.message);
    });

    return { success: true, enCours: true, nbCandidats: candidats.length };
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

    // name conservé (en plus de l'url) : c'est le seul identifiant à peu près stable pour
    // faire le lien avec la sélection manuelle de photos (mettre en premier/exclure, voir
    // ScraperControl.jsx) au moment où executerTraitement refera son propre enrichirLot, plus
    // tard — deux appels Otaree indépendants, jamais le même objet. Documents non-image (plans
    // PDF...) exclus ici aussi, comme downloadOtareeImages le fera à la génération : inutile de
    // proposer à l'utilisateur de "mettre en premier" un PDF.
    const images = (lotEnrichi.images || [])
        .filter((img) => !img.mimeType || img.mimeType.startsWith('image/'))
        .map((img) => ({ name: img.name || null, url: img.urls?.medium_fit || img.urls?.medium || img.urls?.large }))
        .filter((img) => img.url);

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
