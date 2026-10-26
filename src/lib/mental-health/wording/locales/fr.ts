import gad7 from "../gad7/fr";
import phq9 from "../phq9/fr";
import sci from "../sci/fr";
import who5 from "../who5/fr";
import type { LocaleWording } from "../types";

/** Every questionnaire in one language, loaded as one chunk. */
const wording: LocaleWording = { PHQ9: phq9, GAD7: gad7, WHO5: who5, SCI: sci };

export default wording;
