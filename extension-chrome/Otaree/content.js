(function() {
if (window.otareeContentInjected) return;
window.otareeContentInjected = true;

// Injection of the interceptor script
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inject.js');
s.onload = function() {
    this.remove();
};
(document.head || document.documentElement).appendChild(s);

// Bouton "Extraire les lots" retiré du site Otaree (2026-09) : le dashboard fait désormais la
// recherche/extraction directement via l'API Otaree. La capture du refresh_token ci-dessus
// (inject.js) est indépendante de ce bouton — purement passive via l'interception fetch/XHR —
// son retrait n'a donc aucun effet dessus. Les variables et écouteurs ci-dessous restent : le
// déclenchement via l'icône de la barre d'outils (chrome.action.onClicked, voir background.js)
// reste fonctionnel, avec un fallback qui démarre directement le scraping sans bouton visible.
let extractBtn = null;
let pauseBtn = null;
let btnText = null;
let progressBar = null;
let isScrapePaused = false;
let isScrapeRunning = false;

function resetButtonsState() {
    isScrapeRunning = false;
    isScrapePaused = false;
    if (extractBtn) {
        extractBtn.disabled = false;
        extractBtn.classList.remove('loading');
    }
    if (pauseBtn) {
        pauseBtn.style.display = "none";
        pauseBtn.classList.remove('resumed');
        pauseBtn.innerText = "⏸ Pause";
    }
}

// Listen for messages from inject.js to update UI or handle downloads
window.addEventListener('message', function(e) {
    if (e.source !== window || !e.data || e.data.source !== 'otaree-scraper') {
        return;
    }
    
    if (e.data.type === 'SCRAPE_PROGRESS') {
        if (extractBtn && btnText && progressBar) {
            btnText.innerText = e.data.message;
            if (e.data.percent !== undefined) {
                progressBar.style.width = e.data.percent + "%";
            }
        }
    } else if (e.data.type === 'SCRAPE_PAUSED') {
        if (extractBtn && btnText && progressBar) {
            btnText.innerText = e.data.message;
            if (e.data.percent !== undefined) {
                progressBar.style.width = e.data.percent + "%";
            }
        }
    } else if (e.data.type === 'SCRAPE_DONE') {
        if (extractBtn && btnText && progressBar) {
            progressBar.style.width = "100%";
            btnText.innerText = "Terminé !";
            extractBtn.classList.remove('loading');
        }
        setTimeout(() => {
            resetButtonsState();
            if (btnText) btnText.innerText = "Extraire les lots";
            if (progressBar) progressBar.style.width = "0%";
        }, 3000);
        // Send data to background script for native downloads handling
        chrome.runtime.sendMessage({
            action: 'SCRAPE_FINISHED_NATIVE',
            data: e.data.data,
            searchUrl: e.data.searchUrl
        }).catch(() => {});
    } else if (e.data.type === 'REFRESH_TOKEN_CAPTURED') {
        // Relais best-effort vers le dashboard — capture indépendante du flux d'extraction ci-dessus.
        chrome.runtime.sendMessage({
            action: 'OTAREE_REFRESH_TOKEN',
            refreshToken: e.data.refreshToken,
            device: e.data.device,
            instanceId: e.data.instanceId
        }).catch(() => {});
    } else if (e.data.type === 'SCRAPE_ERROR') {
        alert("Erreur d'extraction : " + e.data.message);
        if (extractBtn && btnText && progressBar) {
            btnText.innerText = "Erreur !";
            extractBtn.classList.remove('loading');
        }
        setTimeout(() => {
            resetButtonsState();
            if (btnText) btnText.innerText = "Réessayer";
            if (progressBar) progressBar.style.width = "0%";
        }, 3000);
        console.error("Scrape Error from inject.js:", e.data.message);
    }
});

// Listen for messages from background.js (clicks on extension icon, downloads progress)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'START_SCRAPE') {
        if (!isScrapeRunning) {
            const btn = document.getElementById('otaree-extractor-action');
            if (btn) {
                btn.click();
            } else {
                isScrapeRunning = true;
                window.postMessage({ type: 'START_SCRAPE' }, '*');
            }
        } else {
            // Toggle pause if clicked again while running
            if (pauseBtn) pauseBtn.click();
        }
    } else if (message.action === 'UPDATE_PROGRESS') {
        if (extractBtn && btnText && progressBar) {
            btnText.innerText = message.message;
            if (message.percent !== undefined) {
                progressBar.style.width = message.percent + "%";
            }
            if (message.percent === 100) {
                progressBar.style.width = "100%";
                extractBtn.classList.remove('loading');
                setTimeout(() => {
                    resetButtonsState();
                    btnText.innerText = "Extraire les lots";
                    progressBar.style.width = "0%";
                }, 3000);
            }
        }
    }
});
})();
