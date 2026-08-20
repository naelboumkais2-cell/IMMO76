# IMMO76 — Dashboard

Contrôle centralisé du pipeline scraping → diffusion Ubiflow → publication multi-portails.
Voir `CLAUDE.md` à la racine du repo : ce dossier est la zone de travail principale,
contrairement à `extension-chrome/` qui est du code de production à ne pas modifier.

## Stack

- **Backend** : Node.js + Express + SQLite (`better-sqlite3`, embarqué, sans serveur à
  gérer). API REST simple, cohérente avec le style déjà utilisé dans `Ubiflow-Auto-API/`.
- **Frontend** : React + Vite, en JavaScript (pas de TypeScript, pour rester cohérent
  avec le reste du repo qui est 100% JS).

## Démarrer en développement

Deux terminaux :

```bash
# Terminal 1 — backend (API sur http://localhost:4100)
cd dashboard/server
npm install
npm run dev

# Terminal 2 — frontend (UI sur http://localhost:5173, proxy /api vers le backend)
cd dashboard/client
npm install
npm run dev
```

Ouvrir http://localhost:5173.

## Architecture

```
dashboard/
  server/
    src/
      db.js                    Schéma SQLite + init
      integrations/
        scraperEngine.js       MOCK — contrat run() -> { annonces, erreur }
        hubiflowClient.js      MOCK — contrat publish(annonce, portail, mode) -> { success, adId|error }
      services/
        orchestrator.js        Scrape -> route vers les portails -> publie automatiquement
      routes/                  API REST (scraper, portails, annonces, logs)
      index.js                 App Express + scheduler de fréquence
  client/
    src/
      components/
        ScraperControl.jsx     Bloc 1 : activer/déclencher/statut du scraper
        RoutingConfig.jsx      Bloc 2 : portails + règles de routage par défaut
        Supervision.jsx        Bloc 3 : statuts par (annonce, portail) + logs
```

### Remplacer les mocks par les vraies implémentations

`scraperEngine.js` et `hubiflowClient.js` sont volontairement isolés avec un contrat de
fonction stable (voir les commentaires en tête de chaque fichier). Pour brancher le vrai
scraping Autari ou les vrais appels Ubiflow, il suffit de réécrire le corps de ces
fonctions en gardant la même signature et la même forme de retour — aucune autre partie
du code (orchestrator, routes, frontend) n'a besoin de changer.

Contrainte à garder en tête pour la vraie implémentation du scraper : pas de "scraping
global en continu". L'usage réel est une recherche manuelle sur Autari (filtres variables
à chaque fois) puis un scrape de la page de résultats via l'extension Otaree. Chaque run
est donc rattaché à une **recherche**, identifiée par l'URL de cette page de résultats —
URL reçue automatiquement de l'extension (jamais saisie à la main dans le dashboard).
`scraperEngine.run(url?)` reflète ce contrat : `url` fournie = rescrape d'une recherche
existante, omise = nouvelle recherche (le mock génère alors une URL factice). Le dashboard
et l'extension Otaree ne sont pas encore connectés — cette connexion sera faite dans une
étape dédiée ultérieure ; pour l'instant `extension-chrome/Otaree/` n'est pas modifié.

## Schéma de données

- `recherches` — une ligne par recherche Autari suivie (identifiée par son URL unique) :
  fréquence de rescraping programmé (`frequence_minutes`, `null` = manuel uniquement),
  date/résultat du dernier run.
- `scraper_runs` — historique des exécutions par recherche (date, nb d'annonces trouvées,
  erreur éventuelle) ; plusieurs runs successifs sur la même URL sont rattachés à la même
  recherche plutôt que traités comme des recherches distinctes.
- `annonces` — une ligne par annonce scrapée (dédupliquée par `external_id`), rattachée à
  la recherche (`recherche_id`) qui l'a produite.
- `portails` — un "portail" est un **espace Hubiflow** de l'agence (`login`, ex. `ag762216`),
  pas un site d'annonces externe : il n'y a qu'un point de publication réel (Hubiflow), qui
  redistribue lui-même en interne. Chacun a un mode de publication par défaut (brouillon /
  actif) et un flag `est_espace_actif` — dans la réalité, un seul token/espace est actif à
  la fois côté serveur (voir `Ubiflow-Auto-API/server.js` et `token_stealer.js`, mécanisme
  validé en conditions réelles). La bascule d'espace exposée dans l'UI est mockée pour
  l'instant (aucune action réelle sur le token) ; la vraie connexion est une étape séparée.
- `annonce_portails` — table de liaison : **un statut et un mode par (annonce, portail)**,
  pas un statut unique par annonce (`en_attente` → `envoyee` → `publiee` / `erreur`).
- `regles_routage` — règles par défaut (type de bien → portails) pour le routage
  automatique ; sans règle correspondante, diffusion vers tous les portails actifs.
- `logs_api` — historique des appels scraper et Ubiflow (succès/échec).

Le flux est automatique par défaut (pas de validation manuelle obligatoire) : dès qu'une
annonce est scrapée, elle est routée puis publiée. L'édition/republish manuel reste
possible depuis la supervision, mais reste une action optionnelle, pas une étape
bloquante du flux.
