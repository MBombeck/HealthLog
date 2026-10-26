import gad7 from "../gad7/de";
import phq9 from "../phq9/de";
import sci from "../sci/de";
import who5 from "../who5/de";
import type { LocaleWording } from "../types";

/** Every questionnaire in one language, loaded as one chunk. */
const wording: LocaleWording = { PHQ9: phq9, GAD7: gad7, WHO5: who5, SCI: sci };

export default wording;
