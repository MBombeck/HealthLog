import gad7 from "../gad7/pl";
import phq9 from "../phq9/pl";
import sci from "../sci/pl";
import who5 from "../who5/pl";
import type { LocaleWording } from "../types";

/** Every questionnaire in one language, loaded as one chunk. */
const wording: LocaleWording = { PHQ9: phq9, GAD7: gad7, WHO5: who5, SCI: sci };

export default wording;
