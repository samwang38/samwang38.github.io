"""Build the personal Photos → clipboard → existing website shortcut.

No API key or schedule image is embedded. Sign with Apple's `shortcuts sign`.
"""
import pathlib
import plistlib
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
actions = []


def output(action_id):
    return {"WFSerializationType": "WFTextTokenAttachment", "Value": {
        "Type": "ActionOutput", "OutputUUID": action_id, "OutputName": "Result"}}


def action(identifier, **parameters):
    action_id = str(uuid.uuid4()).upper()
    actions.append({"WFWorkflowActionIdentifier": identifier,
                    "WFWorkflowActionParameters": {"UUID": action_id, **parameters}})
    return action_id


first = action("is.workflow.actions.getitemfromlist", WFItemSpecifier="First Item",
               WFInput={"WFSerializationType": "WFTextTokenAttachment", "Value": {"Type": "ExtensionInput"}})
image = action("is.workflow.actions.image.convert", WFInput=output(first),
               WFImageFormat="JPEG", WFImageCompressionQuality=0.95, WFImagePreserveMetadata=False)
encoded = action("is.workflow.actions.base64encode", WFInput=output(image),
                 WFEncodeMode="Encode", WFBase64LineBreakMode="None")
prefix = "ELIS_SCHEDULE_IMAGE_V1:"
text = action("is.workflow.actions.gettext", WFTextActionText={
    "WFSerializationType": "WFTextTokenString", "Value": {
        "string": prefix + "\ufffc", "attachmentsByRange": {
            "{%d, 1}" % len(prefix): {"Type": "ActionOutput", "OutputUUID": encoded,
                                     "OutputName": "Base64 Encoded"}}}})
action("is.workflow.actions.setclipboard", WFInput=output(text), WFLocalOnly=True)
url = action("is.workflow.actions.url", WFURLActionURL="https://samwang38.github.io/#shortcut")
action("is.workflow.actions.openurl", WFInput=output(url))

workflow = {
    "WFWorkflowName": "班表轉行事曆",
    "WFWorkflowClientVersion": "4018.0.4",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4251333119, "WFWorkflowIconGlyphNumber": 59424},
    "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowInputContentItemClasses": ["WFImageContentItem"],
    "WFWorkflowOutputContentItemClasses": [],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowImportQuestions": [],
    "WFQuickActionSurfaces": [],
    "WFWorkflowActions": actions,
}
target = ROOT / "shortcuts" / "班表轉行事曆-unsigned.plist"
target.write_bytes(plistlib.dumps(workflow))
print(target)
