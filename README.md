# makita-battery-diagnostics — app web

App no navegador para **ler e diagnosticar baterias Makita** (LXT 14,4/18 V, XGT 40 V e CXT 12 V)
por uma ponte Arduino Nano (USB-serial ↔ bateria), usando Web Serial.

**Abrir o app:** https://paulofloresjunior.github.io/makita-battery-diagnostics-web/

- Funciona no **Chrome** e no **Edge** (desktop). Firefox e Safari não têm Web Serial.
- Sem hardware, dá para abrir e comparar leituras salvas (dumps JSON).
- O Arduino precisa do firmware do projeto (comandos `0xD0`/`0xD1`/`0xE0`/`0xE1`); com o firmware
  original do Open Battery Information só a leitura LXT funciona (selecione "LXT").
- XGT e CXT ainda não foram validados em baterias reais.

> **Segurança:** baterias de lítio guardam muita energia. Uma bateria travada geralmente está
> travada por um motivo; desbloquear não conserta a causa. XGT chega a 42 V: nunca ligue os contatos
> de potência ao Arduino.

Este repositório é **gerado automaticamente** a partir da pasta `web/` do projeto principal (privado):
não edite aqui, as mudanças são sobrescritas.

## Créditos

Construído sobre o [Open Battery Information](https://github.com/mnh-jansson/open-battery-information)
(Martin Jansson, MIT) e sobre fatos de protocolo publicados por
[rosvall](https://codeberg.org/rosvall/makita-lxt-protocol),
[synrais](https://github.com/synrais/Makita-LXT-Battery-Monitor-Unlocker),
[TheRepairforge](https://github.com/TheRepairforge),
[drakosha](https://github.com/drakosha/makita-battery-tools),
[Malvineous](https://github.com/Malvineous/makita-xgt-serial),
[twaymouth](https://github.com/twaymouth/XGT-Tester) e
[m5din](https://github.com/no-body-in-particular/m5din-makita-xgt). Nenhum código desses
projetos foi copiado: os fatos foram reimplementados.

## Licença

MIT — veja [LICENSE](LICENSE).
