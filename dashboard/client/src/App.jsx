import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ScraperControl } from './components/ScraperControl.jsx';
import { RoutingConfig } from './components/RoutingConfig.jsx';
import { Supervision } from './components/Supervision.jsx';
import { Historique } from './components/Historique.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Login } from './components/Login.jsx';

export function App() {
    // undefined = vérification en cours (évite un flash de l'écran de connexion avant d'avoir
    // la réponse de GET /auth/moi) ; null = pas connecté ; objet = connecté.
    const [utilisateur, setUtilisateur] = useState(undefined);
    const [hubiflowMode, setHubiflowMode] = useState(null);
    const [pauseDepense, setPauseDepense] = useState(null);
    // 'scraper'/'supervision' : les 2 actions principales, à égalité dans la barre de nav.
    // 'routing'/'historique' : accès secondaire (sidebar gauche), pas en concurrence visuelle
    // avec les 2 actions principales — configuration/consultation occasionnelle, pas un geste
    // quotidien.
    const [activeTab, setActiveTab] = useState('scraper');

    useEffect(() => {
        api.getMoi()
            .then(setUtilisateur)
            .catch(() => setUtilisateur(null));
    }, []);

    // Un 401 sur n'importe quel appel de l'app (pas juste /auth/moi) signale une session
    // expirée en cours d'usage — voir api.js, request(). Renvoie directement vers l'écran de
    // connexion, sans attendre une action explicite de l'utilisateur.
    useEffect(() => {
        function onSessionExpiree() {
            setUtilisateur(null);
        }
        window.addEventListener('auth:expiree', onSessionExpiree);
        return () => window.removeEventListener('auth:expiree', onSessionExpiree);
    }, []);

    // Poll (pas juste au montage) : le badge doit toujours refléter l'état réel du serveur,
    // même si celui-ci a été redémarré dans un mode différent pendant que l'onglet reste ouvert
    // — critique maintenant que HUBIFLOW_MODE=reel est le défaut permanent. Seulement une fois
    // connecté (la route est désormais protégée). 30s plutôt que 5s : cette valeur ne change
    // quasiment jamais en pratique, et ce bandeau est visible en permanence quel que soit
    // l'onglet actif — inutile de sonder aussi souvent (voir le même arbitrage dans
    // Historique.jsx/Supervision.jsx pour les pages qui, elles, ne sondent que si visibles).
    useEffect(() => {
        if (!utilisateur) return;
        const refresh = () =>
            api.getHubiflowMode()
                .then((r) => setHubiflowMode(r.mode))
                .catch(() => setHubiflowMode(null));
        refresh();
        const id = setInterval(refresh, 30000);
        return () => clearInterval(id);
    }, [utilisateur]);

    // Bandeau visible en permanence (pas juste dans Réglages) quand la génération IA/
    // auto-publication est en pause pour dépassement de plafond — voir DepenseConfig.jsx pour
    // le détail et le bouton de reprise. 60s : cet état ne change pas assez vite pour justifier
    // un sondage plus fréquent (le contrôle serveur lui-même ne tourne que toutes les 10 min).
    useEffect(() => {
        if (!utilisateur) return;
        const refresh = () =>
            api.getDepenses()
                .then((d) => setPauseDepense(d.pause?.en_pause ? d.pause : null))
                .catch(() => {});
        refresh();
        const id = setInterval(refresh, 60000);
        return () => clearInterval(id);
    }, [utilisateur]);

    async function onDeconnexion() {
        try {
            await api.logout();
        } catch {
            // Rien de plus à faire si l'appel échoue (déjà déconnecté côté serveur, réseau
            // coupé...) — on renvoie quand même vers l'écran de connexion côté client.
        }
        setUtilisateur(null);
    }

    if (utilisateur === undefined) {
        return <div className="login-ecran" />;
    }

    if (!utilisateur) {
        return <Login onConnecte={setUtilisateur} />;
    }

    const modeReel = hubiflowMode === 'reel';

    return (
        <div className="app-shell">
            <Sidebar activeTab={activeTab} onNavigate={setActiveTab} />

            <div className="app-body">
                <header className="topbar">
                    <div className="brand">
                        <div className="brand-mark">76</div>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="brand-name">IMMO76</span>
                            <span className="brand-tagline">Pipeline scraping → diffusion</span>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span className={`env-pill${modeReel ? ' env-pill-reel' : ''}`}>
                            <span className="dot" />
                            {modeReel ? 'Connecté à Hubiflow (Réel)' : 'Données Mockées'}
                        </span>
                        <span className="cell-muted" title={utilisateur.email}>
                            {utilisateur.nom || utilisateur.email}
                        </span>
                        <button type="button" className="btn-retour" onClick={onDeconnexion}>
                            Déconnexion
                        </button>
                    </div>
                </header>

                {pauseDepense && (
                    <div
                        className="alert alert-danger"
                        style={{ margin: 'var(--space-4) var(--space-6) 0', cursor: 'pointer' }}
                        onClick={() => setActiveTab('routing')}
                        title="Cliquer pour ouvrir Réglages"
                    >
                        <span>
                            Pipeline en pause — plafond de dépense atteint ({pauseDepense.service}). Génération IA et
                            auto-publication arrêtées, la recherche reste disponible. Voir Réglages pour reprendre.
                        </span>
                    </div>
                )}

                <main className="app-main">
                    <nav className="nav-tabs nav-tabs-primary">
                        <button
                            className={`nav-tab nav-tab-large ${activeTab === 'scraper' ? 'active' : ''}`}
                            onClick={() => setActiveTab('scraper')}
                        >
                            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                            <span className="nav-tab-text">
                                <span className="nav-tab-title">Rechercher</span>
                                <span className="nav-tab-subtitle">Lancer une nouvelle recherche Otaree</span>
                            </span>
                        </button>
                        <button
                            className={`nav-tab nav-tab-large ${activeTab === 'supervision' ? 'active' : ''}`}
                            onClick={() => setActiveTab('supervision')}
                        >
                            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                            <span className="nav-tab-text">
                                <span className="nav-tab-title">Superviser</span>
                                <span className="nav-tab-subtitle">État des publications, republier ou dépublier</span>
                            </span>
                        </button>
                    </nav>

                    {/* Les panneaux restent montés en permanence — seule la visibilité change
                        (display: none), jamais un démontage/remontage. Un rendu conditionnel
                        ({activeTab === 'x' && <X/>}) détruirait tout le state local (recherche en
                        cours, filtres en saisie, pagination...) à chaque changement d'onglet, y
                        compris une action réseau en cours dont l'utilisateur perdrait alors toute
                        visibilité (le fetch continue côté serveur, mais plus aucun affichage de
                        progression une fois le composant démonté). */}
                    <div className="tab-content">
                        <div style={{ display: activeTab === 'scraper' ? 'block' : 'none' }}>
                            <ScraperControl />
                        </div>
                        <div style={{ display: activeTab === 'routing' ? 'block' : 'none' }}>
                            <RoutingConfig utilisateur={utilisateur} />
                        </div>
                        <div style={{ display: activeTab === 'supervision' ? 'block' : 'none' }}>
                            <Supervision actif={activeTab === 'supervision'} />
                        </div>
                        <div style={{ display: activeTab === 'historique' ? 'block' : 'none' }}>
                            <Historique actif={activeTab === 'historique'} />
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
