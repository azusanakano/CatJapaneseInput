Installer fixture sources copied verbatim from google/mozc commit
a4541df29db443b49f81cf54665873b68fde9efa (BSD-3-Clause headers retained).

https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/src/win32/custom_action/custom_action.cc
https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/src/win32/installer/installer_oss_64bit.wxs

test/default-input.test.ps1 applies the real CatJapaneseInput branding patch to
these files before testing the resulting install action and MSI conditions.
The test never installs an MSI or changes the computer's input configuration.
