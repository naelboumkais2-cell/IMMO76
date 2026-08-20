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

// Add custom styles for the button and progress bar
const style = document.createElement('style');
style.textContent = `
    .otaree-extractor-container {
        display: inline-flex;
        align-items: center;
        background: rgba(255, 255, 255, 0.4);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.5);
        padding: 6px;
        border-radius: 16px;
        box-shadow: 0 8px 32px rgba(14, 165, 233, 0.1);
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    .otaree-extractor-container:hover {
        box-shadow: 0 12px 40px rgba(14, 165, 233, 0.15);
        transform: translateY(-2px);
    }
    .otaree-extractor-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #7dd3fc 0%, #38bdf8 50%, #0ea5e9 100%);
        background-size: 200% 200%;
        color: white;
        border: none;
        border-radius: 12px;
        padding: 12px 24px;
        font-family: 'Inter', 'Segoe UI', Tahoma, sans-serif;
        font-weight: 600;
        font-size: 14px;
        letter-spacing: 0.5px;
        cursor: pointer;
        position: relative;
        overflow: hidden;
        box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 10;
        width: 250px;
        animation: gradient-shift 5s ease infinite;
    }
    .otaree-extractor-btn::before {
        content: '';
        position: absolute;
        top: 0; left: -100%;
        width: 50%; height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent);
        transform: skewX(-20deg);
        transition: all 0.5s ease;
    }
    .otaree-extractor-btn:hover:not(:disabled) {
        transform: translateY(-2px) scale(1.03);
        box-shadow: 0 8px 25px rgba(14, 165, 233, 0.5);
    }
    .otaree-extractor-btn:hover:not(:disabled)::before {
        left: 150%;
    }
    .otaree-extractor-btn:disabled {
        cursor: default;
        transform: none;
        box-shadow: 0 2px 8px rgba(14, 165, 233, 0.15);
    }
    .otaree-extractor-btn.loading::after {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(255, 255, 255, 0.4);
        animation: simple-pulse 1s ease-in-out infinite alternate;
        z-index: 0;
        pointer-events: none;
    }
    .otaree-extractor-icon {
        margin-right: 10px;
        width: 20px;
        height: 20px;
        fill: currentColor;
        transition: transform 0.3s ease;
        position: relative;
        z-index: 2;
    }
    .otaree-extractor-btn:hover:not(:disabled) .otaree-extractor-icon {
        transform: rotate(15deg) scale(1.1);
    }
    .otaree-extractor-btn.loading .otaree-extractor-icon {
        animation: spin 2s linear infinite;
    }
    .otaree-extractor-text {
        position: relative;
        z-index: 2;
        text-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .otaree-extractor-progress {
        position: absolute;
        top: 0; left: 0; bottom: 0;
        background: rgba(255, 255, 255, 0.3);
        width: 0%;
        transition: width 0.3s linear;
        z-index: 1;
    }
    .otaree-extractor-bg-pulse {
        display: none;
    }
    .otaree-extractor-pause-btn {
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.95);
        color: #0ea5e9;
        border: 1px solid rgba(14, 165, 233, 0.3);
        border-radius: 12px;
        padding: 12px 18px;
        font-family: 'Inter', 'Segoe UI', Tahoma, sans-serif;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        margin-left: 10px;
        box-shadow: 0 4px 15px rgba(14, 165, 233, 0.1);
        transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        z-index: 10;
        position: relative;
        overflow: hidden;
        width: 130px;
    }
    .otaree-extractor-pause-btn:hover {
        transform: translateY(-2px) scale(1.05);
        box-shadow: 0 8px 20px rgba(14, 165, 233, 0.2);
        background: #ffffff;
    }
    .otaree-extractor-pause-btn.resumed {
        background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
        box-shadow: 0 4px 15px rgba(14, 165, 233, 0.3);
    }
    .otaree-extractor-pause-btn.resumed:hover {
        box-shadow: 0 8px 20px rgba(14, 165, 233, 0.5);
    }
    @keyframes gradient-shift {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
    }
    @keyframes simple-pulse {
        0% { opacity: 0; }
        100% { opacity: 1; }
    }
    @keyframes spin {
        100% { transform: rotate(360deg); }
    }
`;
(document.head || document.documentElement).appendChild(style);

let extractBtn = null;
let pauseBtn = null;
let btnText = null;
let progressBar = null;
let isScrapePaused = false;
let isScrapeRunning = false;

function createExtractorButtonContainer() {
    if (document.getElementById('otaree-extractor-wrapper')) return null;

    const wrapper = document.createElement('div');
    wrapper.id = 'otaree-extractor-wrapper';
    wrapper.className = 'otaree-extractor-container';

    const btn = document.createElement('button');
    btn.id = 'otaree-extractor-action';
    btn.className = 'otaree-extractor-btn';
    
    // Icon (Download/Extract)
    const iconSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    iconSvg.setAttribute("viewBox", "0 0 24 24");
    iconSvg.setAttribute("class", "otaree-extractor-icon");
    const iconPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    iconPath.setAttribute("d", "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z");
    iconSvg.appendChild(iconPath);

    btnText = document.createElement('span');
    btnText.className = 'otaree-extractor-text';
    btnText.innerText = "Extraire les lots";

    const pulse = document.createElement('div');
    pulse.className = 'otaree-extractor-bg-pulse';

    progressBar = document.createElement('div');
    progressBar.className = 'otaree-extractor-progress';

    btn.appendChild(iconSvg);
    btn.appendChild(btnText);
    btn.appendChild(pulse);
    btn.appendChild(progressBar);

    // Pause Button
    pauseBtn = document.createElement('button');
    pauseBtn.id = 'otaree-extractor-pause';
    pauseBtn.className = 'otaree-extractor-pause-btn';
    pauseBtn.innerText = "⏸ Pause";

    btn.addEventListener('click', () => {
        if (!isScrapeRunning) {
            isScrapeRunning = true;
            isScrapePaused = false;
            btn.disabled = true;
            btn.classList.add('loading');
            btnText.innerText = "Démarrage...";
            progressBar.style.width = "0%";
            pauseBtn.style.display = "inline-flex";
            pauseBtn.innerText = "⏸ Pause";
            pauseBtn.classList.remove('resumed');
            window.postMessage({ type: 'START_SCRAPE' }, '*');
        }
    });

    pauseBtn.addEventListener('click', () => {
        if (!isScrapeRunning) return;
        if (!isScrapePaused) {
            isScrapePaused = true;
            pauseBtn.innerText = "▶ Reprendre";
            pauseBtn.classList.add('resumed');
            window.postMessage({ type: 'PAUSE_SCRAPE' }, '*');
        } else {
            isScrapePaused = false;
            pauseBtn.innerText = "⏸ Pause";
            pauseBtn.classList.remove('resumed');
            window.postMessage({ type: 'RESUME_SCRAPE' }, '*');
        }
    });

    extractBtn = btn;
    wrapper.appendChild(btn);
    wrapper.appendChild(pauseBtn);
    return wrapper;
}

function findInjectionTarget() {
    // 1. Try the data attribute for the sorter
    let target = document.querySelector('[data-intercom-target="estate-sorter"]');
    if (target && target.parentElement) return target.parentElement;

    // 2. Try looking for the "Trier par" label
    const labels = Array.from(document.querySelectorAll('label'));
    const trierLabel = labels.find(l => l.textContent.includes('Trier par'));
    if (trierLabel) {
        let parent = trierLabel.parentElement;
        for (let i = 0; i < 4; i++) {
            if (parent && parent.tagName !== 'BODY') {
                if (parent.parentElement && window.getComputedStyle(parent.parentElement).display === 'flex') {
                    return parent.parentElement;
                }
                parent = parent.parentElement;
            }
        }
    }

    // 3. Fallback: try finding the properties count container
    const propertiesCount = document.querySelector('[data-intercom-target="estate-properties-count"]');
    if (propertiesCount && propertiesCount.parentElement) {
        return propertiesCount.parentElement;
    }
    
    // 4. Try finding header if all else fails
    const header = document.querySelector('header');
    if (header) return header;

    return null;
}

function injectButton() {
    if (document.getElementById('otaree-extractor-wrapper')) return;
    
    const targetContainer = findInjectionTarget();
    if (targetContainer) {
        const wrapper = createExtractorButtonContainer();
        if (wrapper) {
            targetContainer.appendChild(wrapper);
        }
    }
}

// Observe DOM for changes to inject button when the React page loads
const observer = new MutationObserver(() => {
    if (document.body) {
        injectButton();
    }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
// Try injecting immediately in case it's already there
if (document.body) injectButton();

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
            
            setTimeout(() => {
                resetButtonsState();
                btnText.innerText = "Extraire les lots";
                progressBar.style.width = "0%";
            }, 3000);
        }
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
            
            setTimeout(() => {
                resetButtonsState();
                btnText.innerText = "Réessayer";
                progressBar.style.width = "0%";
            }, 3000);
        }
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
