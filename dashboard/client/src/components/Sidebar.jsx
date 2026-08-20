import { IconSettings, IconHistory } from './icons.jsx';
import { AlertesFavorites } from './AlertesFavorites.jsx';

// Sidebar gauche, toujours visible — accès rapide et discret à 3 pages secondaires (pas des
// actions principales, qui restent les 2 onglets larges Rechercher/Superviser en haut).
// `activeTab` vient de App.jsx : 'routing' et 'historique' sont pilotés d'ici, la notification
// reste un panneau ponctuel (Overlay géré en interne par AlertesFavorites), pas une page.
export function Sidebar({ activeTab, onNavigate }) {
    return (
        <nav className="sidebar">
            <button
                type="button"
                className={`sidebar-nav-btn${activeTab === 'routing' ? ' active' : ''}`}
                onClick={() => onNavigate('routing')}
                title="Règles de routage (configuration des portails)"
            >
                <IconSettings width={20} height={20} />
                <span className="sidebar-nav-label">Réglages</span>
            </button>
            <AlertesFavorites />
            <button
                type="button"
                className={`sidebar-nav-btn${activeTab === 'historique' ? ' active' : ''}`}
                onClick={() => onNavigate('historique')}
                title="Historique des recherches"
            >
                <IconHistory width={20} height={20} />
                <span className="sidebar-nav-label">Historique</span>
            </button>
        </nav>
    );
}
