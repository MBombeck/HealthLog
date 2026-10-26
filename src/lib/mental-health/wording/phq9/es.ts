/**
 * PHQ-9, Spanish: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "Spanish for Spain", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Spanish%20for%20Spain.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Durante las últimas 2 semanas ¿con qué frecuencia le ha molestado alguno de los siguientes problemas?",
  },
  items: [
    "Poco interés o alegría por hacer cosas",
    "Sensación de estar decaído/a, deprimido/a o desesperanzado/a",
    "Problemas para quedarse dormido/a, para seguir durmiendo o dormir demasiado",
    "Sensación de cansancio o de tener poca energía",
    "Poco apetito o comer demasiado",
    "Sentirse mal consigo mismo/a; sentir que es un/a fracasado/a o que ha decepcionado a su familia o a sí mismo/a",
    "Problemas para concentrarse en algo, como leer el periódico o ver la televisión",
    "Moverse o hablar tan despacio que los demás pueden haberlo notado. O lo contrario: estar tan inquieto/a o agitado/a que se ha estado moviendo de un lado a otro más de lo habitual",
    "Pensamientos de que estaría mejor muerto/a o de querer hacerse daño de algún modo",
  ],
  anchors: {
    all: {
      0: "Nunca",
      1: "Varios días",
      2: "Más de la mitad de los días",
      3: "Casi cada día",
    },
  },
  functional: {
    title:
      "Si ha marcado alguno de los problemas de este cuestionario, ¿hasta qué punto estos problemas le han creado dificultades para hacer su trabajo, ocuparse de la casa o relacionarse con los demás?",
    anchors: {
      0: "Ninguna dificultad",
      1: "Algunas dificultades",
      2: "Muchas dificultades",
      3: "Muchísimas dificultades",
    },
  },
};

export default wording;
