// Sélecteur mock/réel pour la publication Hubiflow — un seul endroit qui décide, pour que
// personne d'autre n'ait à vérifier process.env.HUBIFLOW_MODE. Réel par défaut depuis que
// AUTO_PUBLISH=on est lui-même devenu le défaut pour un usage régulier — les deux doivent
// rester cohérents (sinon les recherches tourneraient silencieusement en mock, donnant
// l'impression que rien ne s'est passé). Repasser en mock reste possible explicitement
// (HUBIFLOW_MODE=mock), par exemple pour rejouer des tests sans toucher au vrai Hubiflow.
import * as mock from './hubiflowClient.js';
import * as reel from './hubiflowClientReel.js';

export const mode = process.env.HUBIFLOW_MODE === 'mock' ? 'mock' : 'reel';

if (mode === 'reel') {
    console.log('[hubiflow] ⚠️  Mode RÉEL actif (défaut) — les publications iront vraiment vers Hubiflow.');
} else {
    console.log('[hubiflow] Mode mock actif — aucun appel réseau vers Hubiflow.');
}

const client = mode === 'reel' ? reel : mock;

export const publish = client.publish;
export const depublier = client.depublier;
export const lireEtat = client.lireEtat;
