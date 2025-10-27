// src/jobs/motivationalMessageJob.js
const cron = require('node-cron');
const { Client, sequelize } = require('../database');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const { sendWhatsappMessage } = require('../services/whatsappService');

const motivationalPhrases = [
  "✨ Acredite em você. Você é mais forte do que pensa e mais capaz do que imagina.",
  "🚀 Não espere por oportunidades, crie-as! O futuro pertence a quem se prepara hoje.",
  "💪 A persistência realiza o impossível. Continue firme no seu propósito.",
  "🌟 O sucesso é a soma de pequenos esforços repetidos dia após dia.",
  "😊 A jornada de mil quilômetros começa com um único passo. Dê o seu hoje!",
  "💡 Sua mente é um campo fértil. Plante sementes de otimismo e colha uma vida de realizações.",
  "☀️ Cada amanhecer é um convite para recomeçar e fazer diferente.",
  "🎯 Defina suas metas, trace seu plano e não pare até chegar lá.",
  "🌊 Não tenha medo da mudança. Um mar calmo nunca fez um marinheiro habilidoso.",
  "🔥 A paixão é a energia que ilumina o caminho para seus sonhos. Mantenha a chama acesa.",
  "🌱 O crescimento pessoal é como uma árvore; precisa de tempo, cuidado e raízes fortes.",
  "🧗‍♂️ Os maiores obstáculos da sua vida são as muralhas que você constrói em sua mente.",
  "⭐ Você não precisa ver a escada inteira, apenas dê o primeiro degrau com fé.",
  "💖 A gentileza é a linguagem que o surdo pode ouvir e o cego pode ver. Espalhe-a.",
  "⏳ O tempo é o seu ativo mais valioso. Use-o com sabedoria.",
  "🙌 A gratidão transforma o que temos em suficiente.",
  "💫 Sonhe grande, trabalhe duro e mantenha-se humilde.",
  "💯 A disciplina é a ponte entre metas e realizações.",
  "🌈 Depois da tempestade, vem o arco-íris. Confie no processo.",
  "🚀 O único lugar onde o sucesso vem antes do trabalho é no dicionário.",
  "🦋 Deixe para trás o que não te leva para frente.",
  "🧭 Sua atitude, não sua aptidão, determinará sua altitude.",
  "💥 A força não vem da capacidade física, mas de uma vontade indomável.",
  "✅ Feito é melhor que perfeito. Comece agora, aprimore depois.",
  "🧠 Invista em si mesmo. É o melhor investimento que você pode fazer.",
  "🌻 Seja como um girassol: busque sempre a luz.",
  "✨ A mágica acontece quando você sai da sua zona de conforto.",
  "🚀 Para chegar aonde a maioria não chega, você precisa fazer o que a maioria não faz.",
  "💪 A dor que você sente hoje será a força que você sentirá amanhã.",
  "🌟 Acreditar é a força que nos permite subir os mais altos degraus na escada da vida.",
  "🎯 Foco, força e fé são os ingredientes para uma jornada de sucesso.",
  "💡 Uma pequena mudança positiva pode mudar todo o seu dia.",
  "☀️ O sol é para as flores o que os sorrisos são para a humanidade.",
  "💖 A vida é 10% o que acontece com você e 90% como você reage a isso.",
  "⏳ A melhor hora para plantar uma árvore foi há 20 anos. A segunda melhor hora é agora.",
  "🙌 Seja a energia que você quer atrair.",
  "💫 A única maneira de fazer um excelente trabalho é amar o que você faz.",
  "💯 A excelência não é um ato, mas um hábito.",
  "🌈 A beleza começa no momento em que você decide ser você mesma.",
  "🚀 O otimismo é a fé em ação. Nada se pode levar a efeito sem otimismo.",
  "🦋 A mudança é a lei da vida. E aqueles que olham apenas para o passado ou para o presente irão com certeza perder o futuro.",
  "🧭 Seus sonhos não têm data de validade. Respire fundo e tente outra vez.",
  "💥 A coragem não é a ausência do medo, mas a decisão de que algo é mais importante que o medo.",
  "✅ O segredo de progredir é começar.",
  "🧠 A educação é a arma mais poderosa que você pode usar para mudar o mundo.",
  "🌻 Onde quer que você vá, vá com todo o seu coração.",
  "✨ Não se preocupe com os fracassos, preocupe-se com as chances que você perde quando nem sequer tenta.",
  "🚀 A vida encolhe ou expande na proporção da sua coragem.",
  "💪 Você é o seu único limite.",
  "🌟 Plante um pensamento, colha uma ação; plante uma ação, colha um hábito; plante um hábito, colha um caráter; plante um caráter, colha um destino.",
  "🎯 A melhor vingança é um sucesso estrondoso.",
  "💡 A criatividade é a inteligência se divertindo.",
  "☀️ Escreva em seu coração que todo dia é o melhor dia do ano.",
  "💖 O amor e a gentileza nunca são desperdiçados. Eles sempre fazem a diferença.",
  "⏳ O futuro depende do que você faz hoje.",
  "🙌 A felicidade não é algo pronto. Ela vem de suas próprias ações.",
  "💫 Para ser insubstituível, é preciso ser diferente.",
  "💯 A qualidade não é um acidente; é sempre o resultado do esforço inteligente.",
  "🌈 O mundo está nas mãos daqueles que têm a coragem de sonhar e de correr o risco de viver seus sonhos.",
  "🚀 A determinação de hoje é o sucesso de amanhã.",
  "🦋 Não julgue cada dia pela colheita que você obtém, mas pelas sementes que você planta.",
  "🧭 A vida é uma aventura ousada ou nada.",
  "💥 Se você pode sonhar, você pode realizar.",
  "✅ O ponto de partida de qualquer conquista é o desejo.",
  "🧠 A mente que se abre a uma nova ideia jamais voltará ao seu tamanho original.",
  "🌻 A alegria está na luta, na tentativa, no sofrimento envolvido e não na vitória propriamente dita.",
  "✨ Seja a mudança que você quer ver no mundo.",
  "🚀 O sucesso não é definitivo, o fracasso não é fatal: o que conta é a coragem de continuar.",
  "💪 A maior glória não é nunca cair, mas sim levantar-se sempre depois de uma queda.",
  "🌟 O único modo de evitar as críticas é não dizer nada, não fazer nada e não ser nada.",
  "🎯 Se você quer ser bem-sucedido, precisa ter dedicação total, buscar seu último limite e dar o melhor de si.",
  "💡 A imaginação é mais importante que o conhecimento.",
  "☀️ Cada dia é uma nova chance para ser melhor. Não melhor que os outros, melhor que si mesmo.",
  "💖 Três coisas na vida que nunca devem ser quebradas: confiança, promessas e corações.",
  "⏳ Não conte os dias, faça os dias contarem.",
  "🙌 Aprenda com o ontem, viva o hoje, espere pelo amanhã.",
  "💫 O design não é apenas o que parece e o que se sente. O design é como funciona.",
  "💯 O esforço contínuo – não a força ou a inteligência – é a chave para destravar nosso potencial.",
  "🌈 A vida não é sobre encontrar a si mesmo. A vida é sobre criar a si mesmo.",
  "🚀 O entusiasmo é a maior força da alma. Conserve-o e nunca lhe faltará poder para conseguir o que deseja.",
  "🦋 As dificuldades preparam pessoas comuns para destinos extraordinários.",
  "🧭 A sabedoria começa na reflexão.",
  "💥 Um campeão é alguém que se levanta quando não consegue.",
  "✅ A ação é a chave fundamental para todo sucesso.",
  "🧠 Uma pessoa que nunca cometeu um erro, nunca tentou nada novo.",
  "🌻 A felicidade é um perfume que não podemos espargir sobre os outros sem que algumas gotas caiam sobre nós mesmos.",
  "✨ O que não te desafia, não te transforma.",
  "🚀 O homem que move montanhas começa carregando pequenas pedras.",
  "💪 Acredite que você pode, assim você já está no meio do caminho.",
  "🌟 Torne-se a pessoa que você gostaria de ter por perto.",
  "🎯 Para ter sucesso, seu desejo de sucesso deve ser maior que seu medo do fracasso.",
  "💡 A genialidade é 1% inspiração e 99% transpiração.",
  "☀️ Comemore cada pequena vitória. Elas são o combustível para as grandes conquistas.",
  "💖 A melhor maneira de prever o futuro é criá-lo.",
  "⏳ O tempo voa, mas a boa notícia é que você é o piloto.",
  "🙌 O segredo da felicidade é liberdade, e o segredo da liberdade, coragem.",
  "💫 Se você não está disposto a arriscar, esteja disposto a uma vida comum.",
  "💯 Faça o seu melhor. O que você planta agora, colherá mais tarde.",
  "🌈 A vida é curta. Sorria enquanto você ainda tem dentes.",
  "🚀 Mire na lua. Mesmo que você erre, você pousará entre as estrelas.",
  "🦋 Não tenha medo de desistir do bom para perseguir o ótimo.",
  "🧭 Um objetivo sem um plano é apenas um desejo.",
  "💥 O talento vence jogos, mas o trabalho em equipe e a inteligência vencem campeonatos.",
  "✅ A oportunidade dança com aqueles que já estão no salão de baile.",
  "🧠 A mente é tudo. O que você pensa, você se torna.",
  "🌻 A vida é sobre criar impacto, não renda.",
  "✨ As pessoas esquecerão o que você disse, esquecerão o que você fez, mas nunca esquecerão como você as fez sentir.",
  "🚀 Comece de onde você está. Use o que você tem. Faça o que você pode.",
  "💪 A diferença entre o ordinário e o extraordinário é aquele pequeno extra.",
  "🌟 Grandes mentes discutem ideias; mentes medianas discutem eventos; mentes pequenas discutem pessoas.",
  "🎯 Não deixe o que você não pode fazer interferir no que você pode fazer.",
  "💡 A lógica pode levar de A a B. A imaginação pode levar a qualquer lugar.",
  "☀️ Para ter lábios atraentes, diga palavras doces.",
  "💖 Você não falha até parar de tentar.",
  "⏳ A vida é uma peça de teatro que não permite ensaios. Por isso, cante, chore, dance, ria e viva intensamente.",
  "🙌 Se a vida te der limões, faça uma limonada.",
  "💫 O sucesso geralmente vem para quem está ocupado demais para procurar por ele.",
  "💯 A melhor preparação para amanhã é fazer o seu melhor hoje.",
  "🌈 A única coisa que fica entre você e seu sonho é a vontade de tentar e a crença de que é realmente possível.",
  "🚀 Vá confiante na direção dos seus sonhos. Viva a vida que você imaginou.",
  "🦋 As pessoas mais felizes não têm o melhor de tudo, elas apenas fazem o melhor com tudo o que têm.",
  "🧭 O caminho para o sucesso está sempre em construção.",
  "💥 Aja como se o que você faz, fizesse a diferença. E faz.",
  "✅ Se você quer levantar a si mesmo, levante outra pessoa.",
  "🧠 A educação formal vai te dar um salário; a autoeducação vai te dar uma fortuna.",
  "🌻 A beleza de uma mulher não está nas roupas que ela veste, na figura que ela carrega ou no modo como penteia o cabelo.",
  "✨ Tudo o que você sempre quis está do outro lado do medo.",
  "🚀 O segredo para ficar à frente é começar.",
  "💪 Não é o mais forte que sobrevive, nem o mais inteligente, mas o que melhor se adapta às mudanças.",
  "🌟 O caráter é a mais importante de todas as virtudes, pois sem coragem, não se pode praticar nenhuma outra virtude com consistência.",
  "🎯 O que quer que você seja, seja bom nisso.",
  "💡 Há apenas uma maneira de evitar críticas: não faça nada, não diga nada, e não seja nada.",
  "☀️ Um sorriso é a curva mais bonita no corpo de qualquer pessoa.",
  "💖 A vida é um eco. Se você não está gostando do que está recebendo, observe o que está emitindo.",
  "⏳ Não é sobre ter tempo, é sobre fazer tempo.",
  "🙌 Nós somos o que fazemos repetidamente. A excelência, então, não é um ato, mas um hábito.",
  "💫 Para realizar grandes coisas, devemos não apenas agir, mas também sonhar; não apenas planejar, mas também acreditar.",
  "💯 A disciplina é a alma de um exército. Torna pequenos os números, proporciona sucesso aos fracos, e estima a todos.",
  "🌈 A coragem está um passo à frente do medo.",
  "🚀 O seu foco determina a sua realidade.",
  "🦋 Seja grato pelas noites que se transformaram em manhãs, amigos que se tornaram família e sonhos que se tornaram realidade.",
  "🧭 Não importa o quão devagar você vá, desde que você não pare.",
  "💥 Se você obedece a todas as regras, perde toda a diversão.",
  "✅ O primeiro passo para chegar a algum lugar é decidir que você não vai ficar onde está.",
  "🧠 A mente é como um paraquedas. Só funciona se estiver aberta.",
  "🌻 A vida é melhor quando você está rindo.",
  "✨ Acredite nos seus sonhos e eles podem se tornar realidade. Acredite em você e você pode torná-los realidade.",
  "🚀 Se você não construir seu sonho, alguém vai te contratar para ajudar a construir o dele.",
  "💪 A força interior é a sua maior arma secreta.",
  "🌟 Você é o artista da sua própria vida. Não entregue o pincel a ninguém.",
  "🎯 Obstáculos são aquelas coisas assustadoras que você vê quando tira os olhos da sua meta.",
  "💡 A inspiração existe, mas ela precisa te encontrar trabalhando.",
  "☀️ A gentileza é gratuita, mas vale muito.",
  "💖 A vida é sobre equilíbrio. Seja gentil, mas não deixe que te usem. Confie, mas não seja ingênuo.",
  "⏳ Você nunca sabe que resultados virão da sua ação. Mas se você não fizer nada, não existirão resultados.",
  "🙌 A verdadeira medida de um homem não se vê na forma como se comporta em momentos de conforto e conveniência, mas em como se mantém em tempos de controvérsia e desafio.",
  "💫 Sonhar, afinal, é uma forma de planejar.",
  "💯 A chave para o sucesso é começar antes de estar pronto.",
  "🌈 As mais belas coisas da vida não podem ser vistas nem tocadas, mas sim sentidas pelo coração.",
  "🚀 Não tenha medo de falhar. Tenha medo de não tentar.",
  "🦋 O único limite para a nossa realização de amanhã serão as nossas dúvidas de hoje.",
  "🧭 A jornada é a recompensa.",
  "💥 A vida é 10% do que acontece comigo e 90% de como eu reajo a isso.",
  "✅ A melhor maneira de se animar é tentar animar outra pessoa.",
  "🧠 A leitura é para a mente o que o exercício é para o corpo.",
  "🌻 Faça mais coisas que te fazem esquecer de olhar para o celular.",
  "✨ A vida é feita de momentos. Não espere por momentos especiais, crie-os.",
  "🚀 A vida começa no final da sua zona de conforto.",
  "💪 Você tem que ser o seu próprio herói porque todo mundo está ocupado tentando salvar a si mesmo.",
  "🌟 Seja você mesmo; todos os outros já existem.",
  "🎯 O segredo da mudança é focar toda a sua energia, não em lutar contra o velho, mas em construir o novo.",
  "💡 A curiosidade sobre a vida em todos os seus aspectos, creio, ainda é o segredo dos grandes criadores.",
  "☀️ A felicidade pode ser encontrada mesmo nas horas mais sombrias, se você se lembrar de acender a luz.",
  "💖 As melhores e mais belas coisas do mundo não podem ser vistas nem tocadas. Elas devem ser sentidas com o coração.",
  "⏳ Há mais coisas na vida do que aumentar a sua velocidade.",
  "🙌 Aja como se o que você faz, fizesse a diferença. E faz.",
  "💫 A única jornada impossível é aquela que você nunca começa.",
  "💯 Se você pode sonhar, você pode fazer.",
  "🌈 A vida não é esperar a tempestade passar, é aprender a dançar na chuva.",
  "🚀 Sua imaginação é sua prévia das próximas atrações da vida.",
  "🦋 O pessimista vê dificuldade em cada oportunidade. O otimista vê oportunidade em cada dificuldade.",
  "🧭 O homem que não tem imaginação, não tem asas.",
  "💥 Ou você corre do dia, ou o dia corre de você.",
  "✅ Acredite que a vida vale a pena ser vivida e sua crença ajudará a criar o fato.",
  "🧠 Aquele que tem um 'porquê' para viver pode suportar quase qualquer 'como'.",
  "🌻 A vida é um presente. Nunca se esqueça de aproveitar e desfrutar cada momento que você tem."
];

function getRandomMotivationalPhrase() {
  return motivationalPhrases[Math.floor(Math.random() * motivationalPhrases.length)];
}

async function checkAndSendDailyMotivation() {
  try {
    const timeZone = process.env.TZ || "America/Sao_Paulo";
    const now = new Date(new Date().toLocaleString("en-US", { timeZone }));
    const todayDateString = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTimeStringHHMM = `${String(currentHour).padStart(2, '0')}:${String(currentMinute).padStart(2, '0')}`;

    // <<< INÍCIO DA MODIFICAÇÃO >>>
    // A query agora filtra clientes com assinatura ativa.
const clientsToSend = await Client.findAll({
      where: {
        wantsMotivationMessage: true,
        status: 'Ativo',
        phone: { [Op.ne]: null },
        [Op.and]: [
          sequelize.where(sequelize.fn('to_char', sequelize.col('motivationMessageTime'), 'HH24:MI'), currentTimeStringHHMM)
        ],
        lastMotivationSentDate: {
          [Op.or]: [null, { [Op.lt]: todayDateString }]
        },
        // Filtro de assinatura ativa
        [Op.or]: [
            { accessLevel: { [Op.in]: ['vitalicio_basico', 'vitalicio_avancado'] } },
            { accessExpiresAt: { [Op.gte]: todayDateString } }
        ]
      },
      attributes: ['id', 'name', 'phone', 'motivationMessageTime']
    });
    // <<< FIM DA MODIFICAÇÃO >>>
    
    if (clientsToSend.length === 0) {
      return;
    }

    logger.info(`[JOB MOTIVAÇÃO] Encontrados ${clientsToSend.length} clientes com plano ativo agendados para ${currentTimeStringHHMM}.`);

    const phrase = getRandomMotivationalPhrase();
    if (!phrase) {
      logger.warn('[JOB MOTIVAÇÃO] Nenhuma frase motivacional disponível. Abortando.');
      return;
    }
    
    logger.info(`[JOB MOTIVAÇÃO] Frase do dia selecionada: "${phrase.substring(0, 50)}..."`);

    for (const client of clientsToSend) {
      try {
        const clientFirstName = client.name ? client.name.split(' ')[0] : 'Você';
        const scheduledTime = client.motivationMessageTime.substring(0, 5);

        const header = `Olá, ${clientFirstName}! ☀️\nSua dose de motivação diária das *${scheduledTime}* chegou!`;
        const body = `\n_"${phrase}"_`;
        const footer = `\n\n---\n*Dica:* Para alterar o horário ou desativar, me diga algo como "mudar horário da motivação para 8h" ou "desativar mensagem motivacional".*`;
        const finalMessage = `${header}\n${body}${footer}`;
        
        const sent = await sendWhatsappMessage(client.phone, finalMessage);
        
        if (sent) {
          await client.update({ lastMotivationSentDate: todayDateString });
          logger.info(`[JOB MOTIVAÇÃO] Mensagem personalizada enviada e registro atualizado para ${client.name} (${client.phone}).`);
        } else {
          logger.error(`[JOB MOTIVAÇÃO] Falha ao enviar para ${client.name} (${client.phone}).`);
        }
      } catch (clientError) {
         logger.error(`[JOB MOTIVAÇÃO] Erro no loop de cliente para ${client.name} (${client.phone}): ${clientError.message}`);
      }
    }
  } catch (error) {
    logger.error('[JOB MOTIVAÇÃO] Erro geral ao verificar e enviar mensagens:', { message: error.message, stack: error.stack });
  }
}

function startMotivationalMessageJob() {
  const schedule = '*/1 * * * *';
  logger.info(`[JOB MOTIVAÇÃO] Agendado para rodar a cada minuto (schedule: ${schedule})`);
  
  cron.schedule(schedule, checkAndSendDailyMotivation, {
    timezone: process.env.TZ || "America/Sao_Paulo",
  });
}

module.exports = startMotivationalMessageJob;