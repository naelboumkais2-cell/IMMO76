# Règles du repo

- `extension-chrome/` : code en PRODUCTION, actuellement fonctionnel. Ne JAMAIS modifier ce dossier, ne pas le lire en détail sauf si je le demande explicitement.
- `dashboard/` : nouveau projet en développement, zone de travail principale pour toutes les prochaines tâches.
- **Documents PDF** : Ne lire un document PDF que lorsqu'il est explicitement pertinent pour la tâche demandée (aucune lecture par précaution ou exploration automatique).

# Architecture — état au 2026-09-13

## Trois services déployés séparément, une seule base

- **Frontend** (`dashboard/client/`, React+Vite) : déployé sur **Vercel** (immo-76.vercel.app). `vercel.json` réécrit `/api/*` vers `https://immo76.onrender.com/api/*` (proxy, timeout externe 120s — voir plus bas pourquoi les recherches longues sont asynchrones).
- **Backend** (`dashboard/server/`, Express+ESM) : service Render **"immo76-dashboard-server"**, URL `immo76.onrender.com`. **Se déploie automatiquement** à chaque push sur `main`.
- **Moteur IA** (`Ubiflow-Auto-API/`, Express+CommonJS) : service Render **"immo76-moteur-ia"**, URL `immo76-moteur-ia.onrender.com`. Contient les prompts de génération, `buildUbiflowPayload`, les appels réels à Hubiflow et OpenAI.
  **⚠️ NE SE DÉPLOIE JAMAIS AUTOMATIQUEMENT** — après tout push touchant ce dossier, il faut aller cliquer manuellement "Deploy latest commit" sur ce service dans Render. C'est la source d'erreur la plus fréquente ("le correctif ne marche pas" alors qu'il suffit de déployer).
- **Base de données** : un seul Postgres **Neon**, partagé par les deux services backend (le frontend n'y touche jamais directement).

## Sécurité / accès

- Toutes les routes humaines sont derrière `exigerConnexion` (session cookie) ou `exigerAdmin` (rôle admin, avec repli `X-Admin-Key`/`ADMIN_SECRET` pour le bootstrap). Les rares routes machine (capture de token Otaree par l'extension, cron externe non utilisé) sont derrière `exigerCleMachine`/`MACHINE_API_KEY`, comparaison à temps constant.
- Comptes réels actuels : 1 admin (naelbmks@gmail.com) + 2 employés (dont cgalliot@plusimmo76.fr, collègue légitime) — même niveau de droits fonctionnels, le rôle ne sert qu'à la gestion des comptes eux-mêmes.
- `.env` (moteur IA, clé OpenAI) et les secrets équivalents ne sont jamais commités (`.gitignore` couvre `.env`/`token.json`/`config.local.json`). Une branche locale `old-history` contient un très vieux commit avec une clé OpenAI en clair — jamais poussée sur GitHub, mais à garder en tête si jamais quelqu'un s'étonne de sa présence en local.

## AUTO_PUBLISH — la variable la plus importante à comprendre

Variable d'env côté `dashboard-server`, lue par `autoPublishConfig.js`, trois valeurs possibles :
- `'off'` : import seul, aucune génération IA ni publication automatique.
- `'test'` : ne traite que les annonces `est_annonce_test=1`.
- `'on'` (**valeur actuelle de production**) : traite toutes les annonces réellement nouvelles, **mais s'arrête systématiquement sur un écran de confirmation humaine** avant toute génération/publication réelle — voir `autoGenererEtPublier` dans `orchestrator.js`. Aucune publication ne part jamais sans un clic explicite sur "Confirmer", quel que soit le mode. C'est ce qui rend `'on'` sûr par défaut.
- Plafond `MAX_PAR_RUN` (env `AUTO_PUBLISH_MAX_PAR_RUN`, défaut 400) : nombre max de candidats retenus par run pour la génération/publication — les lots au-delà restent importés mais jamais proposés automatiquement (voir "Traiter les lots en attente" plus bas).

## Recherche nationale et traitement par vagues

- "France entière" (ville vide dans le formulaire) découpe la recherche en régions, avec repli département par département si une région dépasse le plafond de pagination Otaree (~3000 lots). Reprenable après interruption (`recherches.progression_nationale`) — un run peut être coupé (redémarrage Render, 502 Otaree transitoire) et reprendra exactement où il s'est arrêté au prochain lancement de la même recherche.
- Un run peut laisser des lots importés mais jamais proposés en génération (plafond `MAX_PAR_RUN` atteint, ou reprise après interruption qui ne revisite pas les régions déjà traitées). Ces lots restent en base avec `donnees_ia IS NULL` — c'est le marqueur "jamais traité", pas de colonne dédiée.
- **"Traiter les lots en attente" / "Supprimer les lots en attente"** (écran Rechercher + popover sur la carte "En attente" de Supervision) opèrent sur ce même critère (`donnees_ia IS NULL`), **globalement, toutes recherches confondues** — jamais scopé à une seule recherche.
- **"Retirer ce portail"** (Supervision, par ligne) est un mécanisme différent : il ne supprime qu'une ligne `annonce_portails` orpheline (résidu d'une résolution de portails ambiguë à l'import, confirmée sur un seul des deux portails proposés) — n'apparaît que si l'annonce a déjà une autre ligne réellement publiée ailleurs, jamais sur un lot simplement pas encore traité.

## Synchronisation des disparitions Otaree → Hubiflow

- `dashboard/server/src/services/syncDisparitions.js`, déclenché par un `setInterval` dans `index.js` (vérifie toutes les 30 min si le run du jour a eu lieu après 3h — pas un vrai cron, juste une vérification périodique sur le process persistant Render, ne tourne jamais sur Vercel).
- Sélectionne les lots réellement publiés (`ad_id_externe` non nul, jamais dépubliés), vérifie leur existence sur Otaree en 2 passes : un check par lot d'abord, **une seule** attente de confirmation de 5 min pour tout le run (pas par lot — sinon plusieurs disparitions simultanées feraient exploser la durée), puis re-vérification des seuls candidats retenus avant suppression réelle sur Hubiflow (`depublierInstance`).
- Ne supprime jamais sur un statut "inconnu" (erreur réseau/timeout) — dans le doute, retente la nuit suivante. Jeton Otaree mutualisé sur tout le run (jamais un jeton par lot, pour éviter un rate-limit comme celui déjà rencontré sur l'enrichissement photos).
- État suivi dans la table `sync_disparition_etat` (1 ligne), trace de chaque suppression dans `logs_api` (type `sync_disparition`).

## Génération IA — deux prompts, choisis par portail

- `choisirCheminGeneration` (Ubiflow-Auto-API) choisit le prompt (`callOpenAILmnp` ou `callOpenAINeuf`) selon le **portail de destination réellement confirmé** (pas le dispositif fiscal détecté) — corrigé après un bug réel où un lot LMNP confirmé sur le portail Neuf générait quand même du texte LMNP (la requête de choix du prompt ne filtrait pas par les portails réellement confirmés).
- Les deux chemins partagent le même garde-fou de conformité (`detecterProblemesConformite` : mots interdits, promoteur, cohérence texte/annexe, anti-invention DPE). Le chemin Neuf a deux garde-fous supplémentaires (rentabilité chiffrée non fiable pour ce dispositif, proximité transports/commerces non sourcée — Otaree ne fournit jamais cette donnée de façon fiable dans ce pipeline).
- Champs structurés (surface, étage, exposition, annexes, DPE, adresse) toujours lus depuis les données Otaree réelles (`champsConnusDepuisLot`), jamais devinés par l'IA — y compris la lettre DPE, extraite en repli depuis le texte libre `description` quand `lot.energyClass` est absent.
- Référence de publication : LMNP auto-générée par promoteur reconnu (`{Initiales}-{VILLE}-{n°lot}`), Neuf via une référence de programme saisie manuellement une fois par l'agence (Réglages → "Références de programme (Neuf)", table `programmes_reference`, clé `program.id` Otaree). Les deux sont bien transmises jusqu'à Hubiflow (`reference_generee` → `hubiflowClientReel.js` → `buildUbiflowPayload`).

## Convention de travail

- Toute exploration en base réelle passe par des routes temporaires explicitement commentées `// TEMPORAIRE`, retirées dans le commit suivant une fois le diagnostic terminé — jamais laissées en place. Vérifier périodiquement avec `grep -rn "TEMPORAIRE\|/diag-"` qu'aucune n'a été oubliée.
- Toute modification touchant `Ubiflow-Auto-API/` nécessite un rappel explicite à l'utilisateur pour le déploiement manuel sur Render avant de pouvoir tester.
- Plafonds de dépense (Neon/OpenAI) configurés dans Réglages (`parametres_depense`), avec pause automatique du pipeline si dépassés — vérifiables via `GET /api/depenses`.
