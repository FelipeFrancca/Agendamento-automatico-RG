const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LOCALIDADE_ALVO = process.env.LOCALIDADE ? process.env.LOCALIDADE.toUpperCase() : null;
const MAX_TENTATIVAS_VAGAS = Number(process.env.MAX_TENTATIVAS_VAGAS || 8);

// ==========================================
// LOGGING — reseta a cada inicialização
// ==========================================
const LOG_PATH = path.join(__dirname, 'bot.log');
let _logStream = null;

const _origLog = console.log.bind(console);
console.log = (...args) => {
  const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const linha = `[${ts}] ${msg}`;
  _origLog(linha);
  if (_logStream) _logStream.write(linha + '\n');
};

const _origError = console.error.bind(console);
console.error = (...args) => {
  const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const linha = `[${ts}] [ERRO] ${msg}`;
  _origError(linha);
  if (_logStream) _logStream.write(linha + '\n');
};

process.on('exit', () => { if (_logStream) _logStream.end(); });

async function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clicarBotaoProsseguir(page) {
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const txt = await page.evaluate(el => el.innerText.toLowerCase(), btn);
    if (txt.includes('prosseguir') || txt.includes('avançar')) {
      await btn.click();
      return true;
    }
  }
  return false;
}

async function refreshCaptcha(page) {
  const ok = await page.evaluate(() => {
    const botoes = Array.from(document.querySelectorAll('button, [role="button"], svg, i'));
    const candidato = botoes.find(el => {
      const txt = (el.innerText || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      return txt.includes('captcha') || aria.includes('captcha') || title.includes('captcha') ||
             txt.includes('atualizar') || aria.includes('atualizar') || title.includes('atualizar') ||
             txt.includes('refresh') || aria.includes('refresh') || title.includes('refresh');
    });
    if (!candidato) return false;
    candidato.click();
    return true;
  });

  if (ok) {
    await esperar(700);
  }
}

async function selecionarDiaHorario(page, tentativa) {
  const selecao = await page.evaluate((tentativaAtual) => {
    const dias = Array.from(document.querySelectorAll('button.MuiPickersDay-root:not(.Mui-disabled), .react-datepicker__day:not(.react-datepicker__day--disabled), td:not(.disabled)'));
    const diasValidos = dias.filter(d => {
      const parse = parseInt((d.innerText || '').trim(), 10);
      return !isNaN(parse) && parse > 0 && parse <= 31;
    });

    if (diasValidos.length === 0) {
      return { ok: false, motivo: 'sem_dia' };
    }

    const idxDia = tentativaAtual % diasValidos.length;
    diasValidos[idxDia].click();

    const horarios = Array.from(document.querySelectorAll('button:not([disabled]), li:not(.disabled)'))
      .filter(el => el.innerText && el.innerText.includes(':') && /\d{2}:\d{2}/.test(el.innerText));

    if (horarios.length === 0) {
      return { ok: false, motivo: 'sem_horario' };
    }

    const idxHorario = tentativaAtual % horarios.length;
    const horario = horarios[idxHorario].innerText.trim();
    horarios[idxHorario].click();

    return { ok: true, horario };
  }, tentativa);

  return selecao;
}

async function lerCaptcha(page) {
  const canvasDataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return canvas ? canvas.toDataURL() : null;
  });

  if (!canvasDataUrl) return '';

  const base64Data = canvasDataUrl.replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const { data: { text } } = await Tesseract.recognize(buffer, 'eng');
  return text.replace(/[^0-9]/g, '').trim();
}

// Captura snapshot de todas as unidades visíveis com quantidade de vagas
async function capturarSnapshotVagas(page, localidadeFiltro) {
  return page.evaluate((filtro) => {
    const unidades = [];
    const paragrafos = Array.from(document.querySelectorAll('p'));
    const vistos = new Set();

    for (const pt of paragrafos) {
      const containerFlex = pt.parentElement;
      if (!containerFlex) continue;

      const outer = containerFlex.parentElement;
      if (!outer || !outer.className.includes('sc-')) continue;

      const chave = containerFlex.innerText.trim();
      if (vistos.has(chave)) continue;
      vistos.add(chave);

      const ps = Array.from(containerFlex.querySelectorAll('p'));
      const cidade = ps[0] ? ps[0].innerText.trim() : '?';
      const data   = ps[1] ? ps[1].innerText.trim() : '?';
      const span   = containerFlex.querySelector('span');
      const vagas  = span ? parseInt(span.innerText.trim(), 10) : null;

      if (filtro && !cidade.toUpperCase().includes(filtro)) continue;

      unidades.push({ cidade, data, vagas });
    }

    return unidades;
  }, localidadeFiltro || null);
}

// Backoff progressivo: 800ms, 1200ms, 1800ms, 2500ms, ... (cresce ~50% por tentativa até 8s)
function calcularBackoff(tentativa) {
  const base = 800;
  const fator = 1.5;
  const maximo = 8000;
  return Math.min(base * Math.pow(fator, tentativa - 1), maximo);
}

async function submeterComRetry(page, nomeCurto, maxTentativas = 8) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const backoff = calcularBackoff(tentativa);

    const selecao = await selecionarDiaHorario(page, tentativa - 1);
    if (!selecao.ok) {
      console.log(`[${nomeCurto}] ⚠️ Tentativa ${tentativa}/${maxTentativas}: sem dia/horário disponível. Aguardando ${backoff}ms...`);
      await esperar(backoff);
      continue;
    }

    await esperar(Math.min(backoff * 0.5, 1200));

    const captcha = await lerCaptcha(page);
    if (captcha.length < 4 || captcha.length > 6) {
      console.log(`[${nomeCurto}] ⚠️ Tentativa ${tentativa}/${maxTentativas}: captcha inválido lido pelo OCR (${captcha || 'vazio'}). Aguardando ${backoff}ms...`);
      await refreshCaptcha(page);
      await esperar(backoff);
      continue;
    }

    const inputCaptcha = await page.$('input[type="number"], input[placeholder*="Captcha"], input[name*="captcha"]');
    if (!inputCaptcha) {
      console.log(`[${nomeCurto}] ⚠️ Campo de captcha não encontrado na tentativa ${tentativa}/${maxTentativas}. Aguardando ${backoff}ms...`);
      await esperar(backoff);
      continue;
    }

    await inputCaptcha.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await inputCaptcha.type(captcha, { delay: 60 });
    await esperar(400);

    const clicou = await clicarBotaoProsseguir(page);
    if (!clicou) {
      console.log(`[${nomeCurto}] ⚠️ Botão de prosseguir não encontrado na tentativa ${tentativa}/${maxTentativas}. Aguardando ${backoff}ms...`);
      await esperar(backoff);
      continue;
    }

    console.log(`[${nomeCurto}] 🧠 Captcha ${captcha} enviado para o horário ${selecao.horario} (tentativa ${tentativa}/${maxTentativas}, backoff ${backoff}ms).`);

    const responseVagas = await page.waitForResponse(
      response => response.url().includes('/api/vagas'),
      { timeout: 10000 }
    ).catch(() => null);

    if (!responseVagas) {
      const abriuFormulario = await page.waitForSelector('input#nome', { timeout: 4000 }).then(() => true).catch(() => false);
      if (abriuFormulario) {
        return true;
      }

      console.log(`[${nomeCurto}] ⚠️ Sem resposta clara da API na tentativa ${tentativa}/${maxTentativas}. Aguardando ${backoff}ms...`);
      await refreshCaptcha(page);
      await esperar(backoff);
      continue;
    }

    const status = responseVagas.status();
    if (status === 400) {
      console.log(`[${nomeCurto}] ⚠️ ERRO 400 em /api/vagas na tentativa ${tentativa}/${maxTentativas}. Aguardando ${backoff}ms antes de tentar outro horário...`);
      await refreshCaptcha(page);
      await esperar(backoff);
      continue;
    }

    if (status >= 200 && status < 300) {
      const abriuFormulario = await page.waitForSelector('input#nome', { timeout: 7000 }).then(() => true).catch(() => false);
      if (abriuFormulario) {
        return true;
      }
    }

    console.log(`[${nomeCurto}] ⚠️ API retornou status ${status} na tentativa ${tentativa}/${maxTentativas}. Aguardando ${backoff}ms...`);
    await refreshCaptcha(page);
    await esperar(backoff);
  }

  return false;
}

// ==========================================
// FUNÇÃO PARA RODAR O AGENDAMENTO PARA UMA PESSOA
// ==========================================
async function agendarParaPessoa(dados) {
  const nomeCurto = dados.nome.split(' ')[0];
  const arquivoComprovante = path.join(__dirname, `comprovante_${dados.nome.replace(/\s+/g, '_')}.pdf`);
  
  console.log(`[${nomeCurto}] Iniciando robô de agendamento...`);

  const browser = await puppeteer.launch({ 
    headless: false, 
    defaultViewport: null,
    args: ['--start-maximized'] 
  });
  
  try {
    const page = await browser.newPage();
    const URL = 'https://agendamento.pci.rn.gov.br/public/agendamento';
    
    let found = false;
    let snapshotLogado = false;

    while (!found) {
      try {
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await esperar(600);

        const clicoUnidade = await page.evaluate((localidadeFiltro) => {
          const elementsInfo = Array.from(document.querySelectorAll('p'));
          for (const pt of elementsInfo) {
            const containerFlex = pt.parentElement;
            if (containerFlex) {
              const textContent = containerFlex.innerText.toUpperCase();
              
              // Filtro de Localidade (se definido no .env)
              if (localidadeFiltro && !textContent.includes(localidadeFiltro)) {
                continue;
              }

              if (!textContent.includes('NOVAS VAGAS') && 
                  !textContent.includes('ESGOTADO') && 
                  !textContent.includes('PERÍODO') && 
                  !textContent.includes('LOCAL')) {
                  
                  if (containerFlex.parentElement && containerFlex.parentElement.className.includes('sc-')) {
                      containerFlex.parentElement.click();
                      return true;
                  }
              }
            }
          }
          return false;
        }, LOCALIDADE_ALVO);

        if (clicoUnidade) {
          if (!snapshotLogado) {
            snapshotLogado = true;
            const snapshot = await capturarSnapshotVagas(page, LOCALIDADE_ALVO).catch(() => []);
            if (snapshot.length > 0) {
              console.log(`[${nomeCurto}] 📋 Snapshot de vagas no momento da detecção:`);
              for (const u of snapshot) {
                const qtd = Number.isFinite(u.vagas) ? u.vagas : 'N/A';
                console.log(`[${nomeCurto}]   • ${u.cidade} — ${u.data} — ${qtd} vaga(s)`);
              }
            } else {
              console.log(`[${nomeCurto}] 📋 Snapshot: nenhuma unidade capturada (página pode ter mudado).`);
            }
          }
          console.log(`[${nomeCurto}] ✅ VAGA ENCONTRADA EM ${LOCALIDADE_ALVO || 'QUALQUER UNIDADE'}!`);
          found = true;
          break;
        } else {
          console.log(`[${nomeCurto}] ⏳ Buscando vagas${LOCALIDADE_ALVO ? ' em ' + LOCALIDADE_ALVO : ''}...`);
          await esperar(1000);
        }
      } catch (e) {
         await esperar(1000);
      }
    }

    if (found) {
       await esperar(1500);

       console.log(`[${nomeCurto}] 🤖 Selecionando dia/horário e enviando captcha com proteção contra erro 400...`);
       await esperar(800);

      const conseguiuAvancar = await submeterComRetry(page, nomeCurto, MAX_TENTATIVAS_VAGAS);
       if (!conseguiuAvancar) {
         throw new Error('Não foi possível avançar após múltiplas tentativas de seleção de vaga/captcha.');
       }
       
       // Espera tela de preenchimento
       await page.waitForSelector('input#nome', { timeout: 0 }); 
       console.log(`[${nomeCurto}] ⚡ Preenchendo formulário...`);
       await esperar(600);

       await page.type('input#nome', dados.nome, {delay: 5});
       await page.type('input#nome_mae', dados.mae, {delay: 5});
       
       const inputTelefone = await page.$('input#telefone');
       if(inputTelefone) {
           await inputTelefone.click();
           await page.type('input#telefone', dados.celular.replace(/\D/g, ''), {delay: 5});
       }

       const inputCpf = await page.$('input#cpf');
       if(inputCpf) {
           await inputCpf.click();
           const cpfLindo = dados.cpf.replace(/\D/g, '');
           await page.type('input#cpf', cpfLindo, {delay: 5});
       }

       const inputNascimento = await page.$('input[placeholder="DD/MM/AAAA"]');
       if(inputNascimento) {
           await inputNascimento.click();
           await page.type('input[placeholder="DD/MM/AAAA"]', dados.data_nasc.replace(/\D/g, ''), {delay: 5});
       }

       console.log(`[${nomeCurto}] ✅ FORMULÁRIO PREENCHIDO! CONFIRME E AGENDAR!`);
       console.log(`[${nomeCurto}] 📸 Monitorando sucesso do agendamento para salvar comprovante...`);

       // MONITOR DE SUCESSO / COMPROVANTE
       // Esperamos a página conter o texto de comprovante ou mudar o URL
       await page.waitForFunction(
         () => document.body.innerText.includes('COMPROVANTE DE AGENDAMENTO') || 
               document.body.innerText.includes('Protocolo:'),
         { timeout: 0 }
       );

       console.log(`[${nomeCurto}] 🎉 AGENDAMENTO CONCLUÍDO! Gerando PDF do comprovante...`);
      await esperar(2000);

       // Emula mídia de impressão para o PDF sair limpo
       await page.emulateMediaType('print');
       
       // Tenta gerar o PDF real
       try {
           // page.pdf() em modo headful (com janela) as vezes falha em versões antigas, 
           // mas em versões recentes do Puppeteer/Chrome ele funciona ou pode ser feito via CDP
           await page.pdf({
               path: arquivoComprovante,
               format: 'A4',
               printBackground: true,
               margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
           });
           console.log(`[${nomeCurto}] 📄 PDF salvo com sucesso em: ${arquivoComprovante}`);
       } catch (pdfErr) {
           console.log(`[${nomeCurto}] ⚠️ Falha ao gerar PDF (Puppeteer headful limitation). Salvando como imagem de alta resolução...`);
           await page.screenshot({ 
             path: arquivoComprovante.replace('.pdf', '.png'), 
             fullPage: true 
           });
           console.log(`[${nomeCurto}] 💾 Comprovante salvo como imagem em: ${arquivoComprovante.replace('.pdf', '.png')}`);
       }
       
       // Apenas por cortesia, enviamos o comando de imprimir para o navegador 
       // para caso o usuário queira ver a caixa de diálogo nativa (Ctrl+P)
       await page.evaluate(() => window.print());

    }
  } catch (err) {
    console.log(`[${nomeCurto}] ❌ Erro:`, err.message);
  }
}

// ==========================================
// INICIALIZAÇÃO
// ==========================================
(async () => {
  _logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
  console.log('='.repeat(60));
  console.log(`Bot iniciado: ${new Date().toLocaleString('pt-BR')}`);
  console.log(`Localidade: ${LOCALIDADE_ALVO || 'qualquer'}`);
  console.log(`Máx. tentativas vagas: ${MAX_TENTATIVAS_VAGAS}`);
  console.log('='.repeat(60));

  const pessoasPath = path.join(__dirname, 'pessoas.json');
  if (!fs.existsSync(pessoasPath)) {
    console.error('Arquivo pessoas.json não encontrado!');
    return;
  }

  const pessoas = JSON.parse(fs.readFileSync(pessoasPath, 'utf8'));
  console.log(`Carregadas ${pessoas.length} pessoas para agendamento.`);
  if (LOCALIDADE_ALVO) console.log(`Filtro de localidade ativo: ${LOCALIDADE_ALVO}`);

  // Rodar todos em paralelo
  await Promise.all(pessoas.map(p => agendarParaPessoa(p)));
})();
