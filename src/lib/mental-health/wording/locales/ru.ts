import gad7 from "../gad7/ru";
import phq9 from "../phq9/ru";
import sci from "../sci/ru";
import who5 from "../who5/ru";
import type { LocaleWording } from "../types";

/** Every questionnaire in Russian, loaded as one chunk. */
const wording: LocaleWording = { PHQ9: phq9, GAD7: gad7, WHO5: who5, SCI: sci };

export default wording;
