const comboBadgeRules = [
  {
    id: 'cb01',
    name: '万花筒挑战者',
    description: '喷不了，这是真大神，万花筒模式享受者！',
    priority: 100,
    when: {
      label_sides_all: ['X:right', 'M:right'],
      outer_sides_all: ['E4:left']
    }
  },
  {
    id: 'cb02',
    name: '手癖重灾区',
    description: '你的机台修行史，就是一部与自身肌肉搏斗的血泪史。你总能在不可思议的地方开发出独属于自己的“人体工学”，然后被它深深反噬。别人打歌看的是底力，你打歌靠的是如何骗过自己那双充满了自主意识的手。',
    priority: 96,
    when: {
      outer_sides_all: ['E4:left', 'E2:right'],
      inner_sides_all: ['I4:right']
    }
  },
  {
    id: 'cb03',
    name: '舞萌TV',
    description: '你不是普通意义上的有存在感，你是那种走到哪都自带节目效果的“活体综艺”。别人未必记得你今天出了什么分，但绝对会对你那种“怎么又是你啊”的难绷气场印象深刻。某种角度上，你本人就是当地舞萌生态的一部分。',
    priority: 92,
    when: {
      inner_sides_all: ['I3:right'],
      label_sides_all: ['T:right', 'M:left'],
      outer_sides_all: ['E3:right']
    }
  },
  {
    id: 'cb04',
    name: '暗黑心理学',
    description: '暗黑心理学，社交的手腕。我才不要和你拼机口牙！',
    priority: 88,
    when: {
      outer_sides_all: ['E1:right'],
      label_sides_all: ['T:right', 'V:right']
    }
  },
  {
    id: 'cb05',
    name: '小时候不懂事',
    description: '如果能坐时光机回到过去，你最想做的事大概是抽当时的自己两巴掌。早知如此何必当初呢！看着屏幕上那些卡在尴尬百分比的成绩，你只能感叹一句：小时候不懂事...',
    priority: 84,
    when: {
      label_sides_all: ['X:left'],
      outer_sides_all: ['E2:right'],
      inner_sides_all: ['I1:right']
    }
  },
  {
    id: 'cb06',
    name: '大水淹没了整座城市',
    description: '那一天，神明把你 B50 里的水分都拿了出来，那场大水淹没了整座城市。',
    priority: 80,
    when: {
      outer_sides_all: ['E4:left', 'E2:left'],
      inner_sides_all: ['I1:right', 'I4:right']
    }
  },
  {
    id: 'cb07',
    name: '仇人对战',
    description: '你和人拼机的时候，不知道的以为在打“仇人对战”',
    priority: 76,
    when: {
      outer_sides_all: ['E1:right'],
      label_sides_all: ['V:right', 'M:left']
    }
  },
  {
    id: 'cb08',
    name: '理论战神（不是101那个理论）',
    description: '如果舞萌出个笔试，你绝对是满分状元；但站在机台前，你只能眼睁睁看着手不听使唤地把打出三A级景区。',
    priority: 72,
    when: {
      inner_sides_all: ['I2:right', 'I4:right'],
      label_sides_all: ['X:left']
    }
  },
  {
    id: 'cb09',
    name: '极品拼机搭子',
    description: '如果舞萌有“最受欢迎搭子”评选，你绝对榜上有名。你喜欢拼机，从来不给对面压力；选歌偏好那些流汗解压的阳间爽谱，不爱越级；就算不小心炸了也绝不红温。和你拼机就像是在做赛博推拿，主打一个血压平稳、极度舒适。',
    priority: 68,
    when: {
      outer_sides_all: ['E1:right', 'E2:left'],
      label_sides_all: ['T:left', 'M:right']
    }
  },
  {
    id: 'cb10',
    name: '纯血底力批',
    description: '你是那种极其传统的硬核玩家。不碰花里胡哨的邪道，不搞理论拆解，就靠肉身去和机台硬碰硬。你偏爱流畅爽谱，且极其眼手合一，看到什么就结结实实地打出什么。你不需要逃课，因为你深信：所有需要逃课的地方，只要底力够硬，全都不过是浮云。你展现的是机厅里最纯正、最不掺假的物理压制。',
    priority: 64,
    when: {
      inner_sides_all: ['I2:left', 'I4:left'],
      label_sides_all: ['T:left', 'X:right']
    }
  },
  {
    id: 'cb11',
    name: '赤石大王',
    description: '你对那些没见过的、配置阴间的魔王曲有着极其狂热的探索欲。你敢越级，爱挑鬼歌，并且拥有着令人发指的初见能力，而且从不拘泥于手法。别人面对新出的阴间谱面往往先观望退缩，而你直接肉身排雷，开辟新手法，且总能在第一把就打出一个让旁人瞠目结舌的初见高分。你不仅是新版本的先驱者，更是各种鬼畜谱面的最佳试毒员。',
    priority: 60,
    when: {
      outer_sides_all: ['E2:right'],
      inner_sides_all: ['I4:right'],
      label_sides_all: ['T:right', 'P:left']
    }
  }
];

const sevenWonders = {
  threshold: 7,
  persona: {
    code: 'H07',
    name: '7 Wonders',
    kicker: '超级隐藏人格已激活',
    priority: 700,
    summary: '你同时点亮了七个隐藏称号。普通的类型学已经很难解释你，剩下的更像一串只有反复试错才能拼出的暗号。你不是刚好撞进某个小彩蛋，而是把整个隐藏系统都撬开了一条缝。',
    song: {
      title: '《7 Wonders》',
      image: './assets/placeholders/hidden-card.svg',
      alt: '7 Wonders 对应曲绘',
      display_title: '7-WONDERS'
    },
    visual: {
      effect_key: 'seven_wonders',
      result_class: 'is-seven-wonders',
      label_text: '7 Wonders',
      label_tier: 'seven_wonders',
      frame_tier: 'seven_wonders',
      share_frame_tier: 'seven_wonders'
    }
  }
};

module.exports = {
  comboBadgeRules,
  sevenWonders
};
