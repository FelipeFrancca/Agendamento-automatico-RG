const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LOCALIDADE_ALVO = process.env.LOCALIDADE ? process.env.LOCALIDADE.toUpperCase() : null;

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

    while (!found) {
      try {
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 600));

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
          console.log(`[${nomeCurto}] ✅ VAGA ENCONTRADA EM ${LOCALIDADE_ALVO || 'QUALQUER UNIDADE'}!`);
          found = true;
          break;
        } else {
          console.log(`[${nomeCurto}] ⏳ Buscando vagas${LOCALIDADE_ALVO ? ' em ' + LOCALIDADE_ALVO : ''}...`);
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (e) {
         await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (found) {
       await new Promise(r => setTimeout(r, 1500)); 

       // Seleciona Dia
       await page.evaluate(() => {
          const dias = Array.from(document.querySelectorAll('button.MuiPickersDay-root:not(.Mui-disabled), .react-datepicker__day:not(.react-datepicker__day--disabled), td:not(.disabled)'));
          const diasValidos = dias.filter(d => {
              const parse = parseInt(d.innerText.trim());
              return !isNaN(parse) && parse > 0 && parse <= 31;
          });
          if(diasValidos.length > 0) diasValidos[0].click();
       });

       await new Promise(r => setTimeout(r, 800)); 
       
       // Seleciona Horário
       await page.evaluate(() => {
           const horarios = Array.from(document.querySelectorAll('button:not([disabled]), li:not(.disabled)'))
              .filter(el => el.innerText.includes(':') && /\d{2}:\d{2}/.test(el.innerText));
           if(horarios.length > 0) horarios[0].click();
       });

       console.log(`[${nomeCurto}] 🤖 Resolvendo Captcha...`);
       await new Promise(r => setTimeout(r, 1200));

       // Listener para capturar erros da API do ITEP
       page.on('response', response => {
         if (response.url().includes('/api/vagas') && response.status() === 400) {
           console.log(`[${nomeCurto}] ⚠️ ERRO 400: O servidor recusou o captcha ou a vaga já foi preenchida por outro!`);
         }
       });

       const canvasDataUrl = await page.evaluate(() => {
           const canvas = document.querySelector('canvas');
           return canvas ? canvas.toDataURL() : null;
       });

       if (canvasDataUrl) {
           const base64Data = canvasDataUrl.replace(/^data:image\/png;base64,/, "");
           const buffer = Buffer.from(base64Data, 'base64');
           const { data: { text } } = await Tesseract.recognize(buffer, 'eng');
           const numbersOnly = text.replace(/[^0-9]/g, '');

           if (numbersOnly.length > 0) {
               console.log(`[${nomeCurto}] 🧠 Captcha identificado: ${numbersOnly}`);
               const inputCaptcha = await page.$('input[type="number"]');
               if (inputCaptcha) {
                   await inputCaptcha.click(); // Garante o foco
                   await new Promise(r => setTimeout(r, 200));
                   await inputCaptcha.type(numbersOnly, { delay: 60 }); // Digitação humana
                   await new Promise(r => setTimeout(r, 600));

                   // Clique mais robusto via Puppeteer em vez de evaluate
                   const buttons = await page.$$('button');
                   for (const btn of buttons) {
                       const txt = await page.evaluate(el => el.innerText.toLowerCase(), btn);
                       if (txt.includes('prosseguir') || txt.includes('avançar')) {
                           await btn.click();
                           console.log(`[${nomeCurto}] 🖱️ Clique em prosseguir efetuado.`);
                           break;
                       }
                   }
               }
           }
       }
       
       // Espera tela de preenchimento
       await page.waitForSelector('input#nome', { timeout: 0 }); 
       console.log(`[${nomeCurto}] ⚡ Preenchendo formulário...`);
       await new Promise(r => setTimeout(r, 600));

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
       await new Promise(r => setTimeout(r, 2000)); 

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
