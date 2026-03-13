# ITEP RG Bot - Automação de Agendamento

Este projeto automatiza o agendamento de emissão de RG no site do ITEP-RN. Ele monitora vagas, resolve captchas via OCR e preenche os dados dos usuários automaticamente.

## 🚀 Funcionalidades

- **Monitoramento Contínuo:** Recarrega a página automaticamente até encontrar vagas.
- **Filtro de Localidade:** Permite focar em uma cidade específica (ex: Natal).
- **Multiprocessamento:** Agenda para várias pessoas ao mesmo tempo (cada uma em sua janela).
- **Resolução de Captcha:** Usa OCR (Tesseract.js) para ler e digitar os números do captcha sozinho.
- **Preenchimento Automático:** Insere todos os dados pessoais (CPF, Nome, Mãe, etc) em milissegundos.
- **Comprovante Automático:** Salva o comprovante em PNG/PDF e abre a janela de impressão (Ctrl+P).

## 🛠️ Configuração

1. **Dependências:**
   Certifique-se de ter o Node.js instalado e rode:
   ```bash
   npm install
   ```

2. **Arquivo `.env`:**
   Configure a localidade preferida:
   ```env
   LOCALIDADE="NATAL"
   ```

3. **Arquivo `pessoas.json`:**
   Adicione os dados das pessoas que deseja agendar seguindo o formato:
   ```json
   [
     {
       "nome": "NOME COMPLETO",
       "mae": "NOME DA MÃE",
       "cpf": "000.000.000-00",
       "data_nasc": "DD/MM/AAAA",
       "celular": "(84) 99999-9999"
     }
   ]
   ```

## 🏃 Como Rodar

Basta executar o script principal:
```bash
node itep_bot.js
```

## ⚠️ Observações Importantes

- O robô abrirá janelas do navegador. **Não feche as janelas** durante o processo.
- O captcha é resolvido automaticamente, mas caso o servidor do ITEP apresente erro 400 (vaga ocupada ou captcha expirado), o robô avisará no terminal.
- Após o preenchimento, o robô salva o comprovante na pasta raiz do projeto.

---
**Desenvolvido para agilizar o processo de agendamento do ITEP-RN.**
