import gad7 from "../gad7/nl";
import phq9 from "../phq9/nl";
import sci from "../sci/nl";
import who5 from "../who5/nl";
import type { LocaleWording } from "../types";

/** Every questionnaire in one language, loaded as one chunk. */
const wording: LocaleWording = { PHQ9: phq9, GAD7: gad7, WHO5: who5, SCI: sci };

export default wording;
